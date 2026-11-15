import { AllocationMethod, ExpenseKind, ExpenseStatus, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { fiscalYear } from "../../lib/numbering";
import { uploadPrivateFile, signedUrl } from "../../lib/storage";
import { objectKey, verifyUpload } from "../../lib/uploads";
import { DEFAULT_CATEGORIES } from "./categories";
import { FinanceAccess, assertApprove, assertManage, assertView, canManage, scopeWhere } from "./access";
import { dateOnly, parseDate, rupeesToPaise, splitByWeights } from "./money";

/**
 * Expenses: all money going out, for central DevUp (startupId null) or a startup.
 *
 *   DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED ──mark paid──▶ PAID
 *                        │  ▲                    │
 *               ask info │  │ resubmit           └─void─▶ VOID
 *                        ▼  │
 *                     NEEDS_INFO      SUBMITTED ──reject──▶ REJECTED (editable → DRAFT)
 *
 * Only the CFO approves, rejects, pays, voids, corrects and splits costs.
 * A PAID expense is never edited or deleted: a mistake is fixed with an
 * ADJUSTMENT entry that points at it. Nothing is ever hard-deleted; drafts
 * are soft-deleted. Every change is written to AuditLog (entity FinanceExpense).
 */

const ENTITY = "FinanceExpense";
const LIVE: ExpenseStatus[] = ["SUBMITTED", "NEEDS_INFO", "APPROVED", "PAID"];
export const FINANCE_BUCKET = () => env.STORAGE_BUCKET_FINANCE;

/* Categories and vendors */

let categoriesEnsured = false;
export async function ensureDefaultCategories() {
  if (categoriesEnsured) return;
  for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
    // Create only: never overwrite a category the CFO renamed or switched off.
    await prisma.financeCategory.upsert({
      where: { key: c.key },
      create: { ...c, sortOrder: i },
      update: {},
    });
  }
  categoriesEnsured = true;
}

export async function listCategories() {
  await ensureDefaultCategories();
  return prisma.financeCategory.findMany({ where: { kind: "EXPENSE" }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export async function listVendors(q?: string) {
  return prisma.vendor.findMany({
    where: { isActive: true, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) },
    orderBy: { name: "asc" },
    take: 100,
  });
}

export type VendorInput = { name: string; kind?: string | null; contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null; gstin?: string | null; notes?: string | null };

export async function createVendor(access: FinanceAccess, input: VendorInput) {
  if (!access.isCfo && access.manageStartups.size === 0) throw new AppError(403, "You can view finance records but not add vendors", "FINANCE_READ_ONLY");
  const name = input.name.trim();
  const exists = await prisma.vendor.findFirst({ where: { name: { equals: name, mode: "insensitive" }, isActive: true } });
  if (exists) throw new AppError(409, `A vendor called "${exists.name}" already exists`, "VENDOR_EXISTS");
  const v = await prisma.vendor.create({
    data: {
      name, kind: input.kind || null, contactName: input.contactName || null, contactEmail: input.contactEmail || null,
      contactPhone: input.contactPhone || null, gstin: input.gstin || null, notes: input.notes || null, createdBy: access.userId,
    },
  });
  await audit({ action: "finance.vendor.created", entity: "FinanceVendor", entityId: v.id, actorId: access.userId, metadata: { name } });
  return v;
}

/* Numbers */

async function scopeCode(tx: Prisma.TransactionClient, startupId: string | null) {
  if (!startupId) return "DEV";
  const s = await tx.startup.findUnique({ where: { id: startupId }, select: { code: true, id: true } });
  if (!s) throw new AppError(404, "No such startup", "NOT_FOUND");
  return s.code ?? `S${s.id.slice(0, 4).toUpperCase()}`;
}

/** EXP-ZAP-2026-27-0001 — per scope, per Indian financial year. Atomic, like lib/numbering. */
export async function nextExpenseNumber(tx: Prisma.TransactionClient, startupId: string | null, on: Date) {
  const code = await scopeCode(tx, startupId);
  const fy = fiscalYear(on);
  const seq = await tx.financeSequence.upsert({
    where: { key: `EXP:${code}:${fy}` },
    create: { key: `EXP:${code}:${fy}`, current: 1 },
    update: { current: { increment: 1 } },
  });
  return `EXP-${code}-${fy}-${String(seq.current).padStart(4, "0")}`;
}

/* Reading */

const include = {
  category: { select: { id: true, key: true, name: true, group: true } },
  vendor: { select: { id: true, name: true } },
  startup: { select: { id: true, name: true, code: true } },
  allocations: { include: { startup: { select: { id: true, name: true, code: true } } }, orderBy: { amountPaise: "desc" as const } },
} satisfies Prisma.ExpenseInclude;

type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof include }>;

async function load(id: string) {
  const e = await prisma.expense.findFirst({ where: { id, deletedAt: null }, include });
  if (!e) throw new AppError(404, "Not found", "NOT_FOUND");
  return e;
}

export type ExpenseFilters = {
  scope?: string; status?: ExpenseStatus; kind?: ExpenseKind; categoryId?: string; vendorId?: string;
  from?: string; to?: string; q?: string; page?: number; pageSize?: number;
};

export async function listExpenses(access: FinanceAccess, f: ExpenseFilters) {
  const where: Prisma.ExpenseWhereInput = {
    deletedAt: null,
    ...scopeWhere(access, f.scope),
    ...(f.status ? { status: f.status } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.categoryId ? { categoryId: f.categoryId } : {}),
    ...(f.vendorId ? { vendorId: f.vendorId } : {}),
    ...(f.from || f.to
      ? { incurredOn: { ...(f.from ? { gte: parseDate(f.from, "start date") } : {}), ...(f.to ? { lte: parseDate(f.to, "end date") } : {}) } }
      : {}),
    ...(f.q
      ? { OR: [{ title: { contains: f.q, mode: "insensitive" } }, { number: { contains: f.q, mode: "insensitive" } }, { payee: { contains: f.q, mode: "insensitive" } }, { vendor: { name: { contains: f.q, mode: "insensitive" } } }] }
      : {}),
  };
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const [rows, total, byStatus] = await Promise.all([
    prisma.expense.findMany({ where, include, orderBy: [{ incurredOn: "desc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.expense.count({ where }),
    prisma.expense.groupBy({ by: ["status"], where, _sum: { amountPaise: true }, _count: true }),
  ]);
  return {
    rows: rows.map(present),
    page, pageSize, total,
    totals: Object.fromEntries(byStatus.map((s) => [s.status, { count: s._count, amountPaise: s._sum.amountPaise ?? 0 }])),
  };
}

function present(e: ExpenseRow) {
  const today = dateOnly(new Date());
  return {
    ...e,
    scope: e.startupId ? "startup" : "central",
    isOverdue: e.status === "APPROVED" && !!e.dueOn && e.dueOn < today,
    allocatedPaise: e.allocations.reduce((s, a) => s + a.amountPaise, 0),
  };
}

export async function getExpense(access: FinanceAccess, id: string) {
  const e = await load(id);
  if (!(e.claimantUserId === access.userId)) assertView(access, e.startupId);
  const [attachments, history, corrections] = await Promise.all([
    prisma.financeAttachment.findMany({ where: { entity: ENTITY, entityId: id, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    prisma.auditLog.findMany({ where: { entity: ENTITY, entityId: id }, orderBy: { createdAt: "asc" } }),
    prisma.expense.findMany({ where: { correctsId: id, deletedAt: null }, select: { id: true, number: true, amountPaise: true, notes: true, createdAt: true } }),
  ]);
  return {
    ...present(e),
    attachments: attachments.map(({ storagePath: _p, ...a }) => a),
    corrections,
    history: history.map((h) => ({ at: h.createdAt, action: h.action, by: h.adminId, details: h.metadata })),
  };
}

/* Writing */

export type ExpenseInput = {
  scope: string; // "central" or a startup id
  kind?: "VENDOR_BILL" | "REIMBURSEMENT";
  title: string;
  description?: string | null;
  businessPurpose?: string | null;
  categoryId: string;
  vendorId?: string | null;
  payee?: string | null;
  amount: string | number;
  currency?: string;
  originalAmount?: string | number | null;
  incurredOn: string;
  dueOn?: string | null;
  paymentMethod?: PaymentMethod | null;
  notes?: string | null;
  /** draft: save only · submit: send for approval · paid: CFO records a bill already paid. */
  action?: "draft" | "submit" | "paid";
  paymentRef?: string | null;
  paidOn?: string | null;
};

type ExpenseData = Prisma.ExpenseUncheckedUpdateInput;

/** Only the fields present in `input` are checked and returned, so a partial edit changes only what it names. */
async function cleanInput(input: Partial<ExpenseInput>) {
  const data: ExpenseData = {};
  cleanText(input, data);
  await cleanReferences(input, data);
  cleanMoney(input, data);
  cleanDates(input, data);
  return data;
}

function cleanText(input: Partial<ExpenseInput>, data: ExpenseData) {
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (t.length < 2) throw new AppError(400, "Give the expense a short title", "TITLE_REQUIRED");
    data.title = t.slice(0, 200);
  }
  for (const k of ["description", "businessPurpose", "payee", "notes"] as const) {
    if (input[k] !== undefined) data[k] = input[k]?.toString().trim().slice(0, 2000) || null;
  }
}

async function cleanReferences(input: Partial<ExpenseInput>, data: ExpenseData) {
  if (input.categoryId !== undefined) {
    await ensureDefaultCategories();
    const c = await prisma.financeCategory.findFirst({ where: { id: input.categoryId, isActive: true, kind: "EXPENSE" } });
    if (!c) throw new AppError(400, "Choose a category", "CATEGORY_REQUIRED");
    data.categoryId = c.id;
  }
  if (input.vendorId === undefined) return;
  if (input.vendorId) {
    const v = await prisma.vendor.findFirst({ where: { id: input.vendorId, isActive: true } });
    if (!v) throw new AppError(400, "That vendor no longer exists", "VENDOR_NOT_FOUND");
  }
  data.vendorId = input.vendorId || null;
}

function cleanMoney(input: Partial<ExpenseInput>, data: ExpenseData) {
  if (input.amount !== undefined) data.amountPaise = rupeesToPaise(input.amount);
  if (input.currency !== undefined) {
    const cur = (input.currency || "INR").toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new AppError(400, "Use a three-letter currency code, like INR or USD", "INVALID_CURRENCY");
    data.currency = cur;
  }
  if (input.originalAmount !== undefined) {
    data.originalAmount = input.originalAmount == null || input.originalAmount === "" ? null : rupeesToPaise(input.originalAmount);
  }
  if (data.currency && data.currency !== "INR" && input.originalAmount == null) {
    throw new AppError(400, "For a foreign-currency receipt, enter the amount on the receipt as well as its value in rupees", "ORIGINAL_AMOUNT_REQUIRED");
  }
}

function cleanDates(input: Partial<ExpenseInput>, data: ExpenseData) {
  if (input.incurredOn !== undefined) {
    const d = parseDate(input.incurredOn, "expense date");
    if (d > dateOnly(new Date(Date.now() + 86400_000))) throw new AppError(400, "The expense date is in the future — use the due date for bills not yet incurred", "DATE_IN_FUTURE");
    data.incurredOn = d;
  }
  if (input.dueOn !== undefined) data.dueOn = input.dueOn ? parseDate(input.dueOn, "due date") : null;
  if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod || null;
}

const scopeFrom = (scope: string) => (scope === "central" ? null : scope);

/** Where an expense came from, set by the module that creates it (never by the request body). */
export type ExpenseOrigin = { source: "EVENT" | "SUBSCRIPTION" | "RECURRING_BILL"; sourceId: string };

export async function createExpense(access: FinanceAccess, input: ExpenseInput, origin?: ExpenseOrigin) {
  const startupId = scopeFrom(input.scope);
  assertManage(access, startupId);
  const action = input.action ?? "submit";
  if (action === "paid") assertApprove(access);
  if (startupId) {
    const s = await prisma.startup.findUnique({ where: { id: startupId }, select: { id: true } });
    if (!s) throw new AppError(404, "Not found", "NOT_FOUND");
  }
  const data = await cleanInput(input);
  if (!data.categoryId || data.amountPaise === undefined || !data.incurredOn || !data.title) {
    throw new AppError(400, "Title, category, amount and date are required", "MISSING_FIELDS");
  }
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const number = await nextExpenseNumber(tx, startupId, data.incurredOn as Date);
    const status: ExpenseStatus = action === "draft" ? "DRAFT" : action === "paid" ? "PAID" : "SUBMITTED";
    const e = await tx.expense.create({
      data: {
        ...(data as Prisma.ExpenseUncheckedCreateInput),
        number,
        startupId,
        kind: input.kind === "REIMBURSEMENT" ? "REIMBURSEMENT" : "VENDOR_BILL",
        status,
        submittedBy: access.userId,
        submittedAt: status === "DRAFT" ? null : now,
        ...(origin ? { source: origin.source, sourceId: origin.sourceId } : {}),
        ...(status === "PAID"
          ? { approvedBy: access.userId, approvedAt: now, paidBy: access.userId, paidAt: input.paidOn ? parseDate(input.paidOn, "payment date") : now, paymentRef: input.paymentRef?.trim() || null }
          : {}),
      } as Prisma.ExpenseUncheckedCreateInput,
    });
    await audit({ action: `finance.expense.created`, entity: ENTITY, entityId: e.id, actorId: access.userId, startupId: startupId ?? undefined, metadata: { number, status, amountPaise: e.amountPaise, ...(origin ?? {}) } }, tx);
    return e;
  });
}

/** Editable fields, by status. PAID and VOID are never edited. */
function editableBy(access: FinanceAccess, e: { status: ExpenseStatus; submittedBy: string; claimantUserId: string | null; startupId: string | null }) {
  if (e.status === "PAID" || e.status === "VOID") return false;
  if (e.status === "APPROVED") return access.isCfo;
  if (canManage(access, e.startupId)) return true;
  return e.claimantUserId === access.userId && ["DRAFT", "SUBMITTED", "NEEDS_INFO", "REJECTED"].includes(e.status);
}

export async function updateExpense(access: FinanceAccess, id: string, input: Partial<ExpenseInput>) {
  const e = await load(id);
  if (e.claimantUserId !== access.userId) assertView(access, e.startupId);
  if (e.status === "PAID") throw new AppError(409, "A paid expense cannot be edited. Add a correction instead.", "PAID_IS_FINAL");
  if (!editableBy(access, e)) throw new AppError(403, "You can't change this expense", "NOT_EDITABLE");

  const data = await cleanInput(input);
  let newScope: string | null | undefined;
  if (input.scope !== undefined) {
    newScope = scopeFrom(input.scope);
    if (newScope !== e.startupId) {
      if (e.claimantUserId === access.userId && !canManage(access, e.startupId)) throw new AppError(403, "Only finance can move a claim to another startup", "NOT_EDITABLE");
      assertManage(access, newScope);
      data.startupId = newScope;
    }
  }
  // Show what changed in the history, not just that something did.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(data)) {
    const before = (e as any)[k];
    const same = before instanceof Date && v instanceof Date ? before.getTime() === v.getTime() : before === v;
    if (!same) changes[k] = { from: before, to: v };
  }
  if (!Object.keys(changes).length) return getExpense(access, id);

  // A rejected expense that is edited goes back to draft, to be resubmitted.
  if (e.status === "REJECTED") data.status = "DRAFT";
  // A split no longer adds up once the amount or owner changes: clear it and say so.
  const splitCleared = e.allocations.length > 0 && ("amountPaise" in changes || "startupId" in changes);

  await prisma.$transaction(async (tx) => {
    if (splitCleared) await tx.expenseAllocation.deleteMany({ where: { expenseId: id } });
    await tx.expense.update({ where: { id }, data });
    await audit({ action: "finance.expense.edited", entity: ENTITY, entityId: id, actorId: access.userId, startupId: (newScope ?? e.startupId) ?? undefined, metadata: { changes, splitCleared } }, tx);
  });
  return { ...(await getExpense(access, id)), splitCleared };
}

async function transition(
  access: FinanceAccess,
  id: string,
  args: { from: ExpenseStatus[]; to: ExpenseStatus; action: string; data?: Prisma.ExpenseUncheckedUpdateInput; metadata?: Record<string, unknown>; who: "cfo" | "manager-or-claimant" },
) {
  const e = await load(id);
  if (args.who === "cfo") {
    assertView(access, e.startupId);
    assertApprove(access);
  } else if (!(e.claimantUserId === access.userId)) {
    assertManage(access, e.startupId);
  }
  if (!args.from.includes(e.status)) {
    throw new AppError(409, `This expense is ${e.status.toLowerCase().replace("_", " ")} — it can't be ${args.action.replace(/_/g, " ")} now`, "WRONG_STATUS");
  }
  // Guard against a concurrent change: the update only applies if the status is still what we read.
  const res = await prisma.$transaction(async (tx) => {
    const n = await tx.expense.updateMany({ where: { id, status: e.status }, data: { ...args.data, status: args.to } });
    if (n.count !== 1) throw new AppError(409, "Someone else just changed this expense. Reload and try again.", "CONFLICT");
    await audit({ action: `finance.expense.${args.action}`, entity: ENTITY, entityId: id, actorId: access.userId, startupId: e.startupId ?? undefined, metadata: { from: e.status, to: args.to, ...args.metadata } }, tx);
    return n;
  });
  void res;
  return getExpense(access, id);
}

export const submitExpense = (a: FinanceAccess, id: string) =>
  transition(a, id, { from: ["DRAFT", "NEEDS_INFO", "REJECTED"], to: "SUBMITTED", action: "submitted", data: { submittedAt: new Date(), reviewNote: null }, who: "manager-or-claimant" });

export const approveExpense = (a: FinanceAccess, id: string, note?: string | null) =>
  transition(a, id, { from: ["DRAFT", "SUBMITTED", "NEEDS_INFO"], to: "APPROVED", action: "approved", data: { approvedBy: a.userId, approvedAt: new Date(), reviewNote: note?.trim() || null }, metadata: { note: note ?? null }, who: "cfo" });

export function rejectExpense(a: FinanceAccess, id: string, reason: string) {
  if (!reason?.trim()) throw new AppError(400, "Say why it's rejected, so it can be fixed", "REASON_REQUIRED");
  return transition(a, id, { from: ["SUBMITTED", "NEEDS_INFO", "APPROVED"], to: "REJECTED", action: "rejected", data: { reviewNote: reason.trim(), approvedBy: null, approvedAt: null }, metadata: { reason }, who: "cfo" });
}

export function requestInfo(a: FinanceAccess, id: string, message: string) {
  if (!message?.trim()) throw new AppError(400, "Say what information is needed", "MESSAGE_REQUIRED");
  return transition(a, id, { from: ["SUBMITTED"], to: "NEEDS_INFO", action: "info_requested", data: { reviewNote: message.trim() }, metadata: { message }, who: "cfo" });
}

export function voidExpense(a: FinanceAccess, id: string, reason: string) {
  if (!reason?.trim()) throw new AppError(400, "Say why it's being voided", "REASON_REQUIRED");
  return transition(a, id, { from: ["DRAFT", "SUBMITTED", "NEEDS_INFO", "APPROVED", "REJECTED"], to: "VOID", action: "voided", data: { reviewNote: reason.trim() }, metadata: { reason }, who: "cfo" });
}

/**
 * Record that an approved expense has been paid. This records a payment made
 * outside the app (bank, UPI, cash); it does not move money.
 * Idempotent: repeating the same call with the same reference changes nothing.
 */
export async function markPaid(a: FinanceAccess, id: string, input: { paidOn?: string | null; paymentMethod?: PaymentMethod | null; paymentRef?: string | null }) {
  const e = await load(id);
  assertView(a, e.startupId);
  assertApprove(a);
  const ref = input.paymentRef?.trim() || null;
  if (e.status === "PAID") {
    if ((e.paymentRef ?? null) === ref) return getExpense(a, id);
    throw new AppError(409, `Already marked paid${e.paymentRef ? ` (reference ${e.paymentRef})` : ""}. To fix a payment, add a correction.`, "ALREADY_PAID");
  }
  const paidAt = input.paidOn ? parseDate(input.paidOn, "payment date") : new Date();
  return transition(a, id, {
    from: ["APPROVED"], to: "PAID", action: "paid",
    data: { paidBy: a.userId, paidAt, paymentRef: ref, ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}) },
    metadata: { paymentRef: ref, paidAt },
    who: "cfo",
  });
}

/**
 * Fix a paid expense without rewriting it: a new ADJUSTMENT entry, already
 * paid, for the difference (negative for a refund or an overstatement).
 */
export async function correctPaid(a: FinanceAccess, id: string, input: { amount: string | number; reason: string; on?: string | null; paymentRef?: string | null }) {
  const e = await load(id);
  assertView(a, e.startupId);
  assertApprove(a);
  if (e.status !== "PAID") throw new AppError(409, "Only a paid expense needs a correction — edit this one directly", "NOT_PAID");
  if (!input.reason?.trim()) throw new AppError(400, "Say what the correction is for", "REASON_REQUIRED");
  const delta = rupeesToPaise(input.amount, { allowNegative: true });
  const on = input.on ? parseDate(input.on, "correction date") : dateOnly(new Date());
  return prisma.$transaction(async (tx) => {
    const number = await nextExpenseNumber(tx, e.startupId, on);
    const adj = await tx.expense.create({
      data: {
        number, startupId: e.startupId, kind: "ADJUSTMENT", title: `Correction to ${e.number}`, description: input.reason.trim(),
        categoryId: e.categoryId, vendorId: e.vendorId, payee: e.payee, amountPaise: delta, currency: "INR", incurredOn: on,
        status: "PAID", submittedBy: a.userId, submittedAt: new Date(), approvedBy: a.userId, approvedAt: new Date(),
        paidBy: a.userId, paidAt: new Date(), paymentRef: input.paymentRef?.trim() || null, correctsId: e.id, notes: input.reason.trim(),
      },
    });
    await audit({ action: "finance.expense.corrected", entity: ENTITY, entityId: e.id, actorId: a.userId, startupId: e.startupId ?? undefined, metadata: { adjustmentId: adj.id, adjustmentNumber: number, amountPaise: delta, reason: input.reason } }, tx);
    await audit({ action: "finance.expense.created", entity: ENTITY, entityId: adj.id, actorId: a.userId, startupId: e.startupId ?? undefined, metadata: { number, status: "PAID", amountPaise: delta, corrects: e.number } }, tx);
    return adj;
  });
}

export async function deleteDraft(a: FinanceAccess, id: string) {
  const e = await load(id);
  if (e.claimantUserId !== a.userId) assertManage(a, e.startupId);
  if (e.status !== "DRAFT") throw new AppError(409, "Only drafts can be deleted. Ask the CFO to void it instead.", "NOT_DRAFT");
  await prisma.$transaction(async (tx) => {
    await tx.expense.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: a.userId } });
    await audit({ action: "finance.expense.draft_deleted", entity: ENTITY, entityId: id, actorId: a.userId, startupId: e.startupId ?? undefined }, tx);
  });
  return { deleted: true };
}

/* Sharing a central cost between startups */

export type AllocationInput = {
  method: AllocationMethod;
  /** Each target: a startup id, or "central" for the part DevUp keeps. */
  shares: Array<{ scope: string; percent?: number | string; amount?: number | string; units?: number | string }>;
  note?: string | null;
};

/** People currently working at each startup: active employees plus interns within their dates. */
export async function headcounts(startupIds: string[]) {
  const today = dateOnly(new Date());
  const [emp, int] = await Promise.all([
    prisma.employee.groupBy({ by: ["startupId"], where: { startupId: { in: startupIds }, status: { in: ["ACTIVE", "NOTICE"] } }, _count: true }),
    prisma.intern.groupBy({ by: ["startupId"], where: { startupId: { in: startupIds }, status: { in: ["ACTIVE", "NOTICE"] }, startDate: { lte: today }, endDate: { gte: today } }, _count: true }),
  ]);
  const out = new Map(startupIds.map((id) => [id, 0]));
  for (const r of [...emp, ...int]) out.set(r.startupId, (out.get(r.startupId) ?? 0) + r._count);
  return out;
}

export async function setAllocations(a: FinanceAccess, id: string, input: AllocationInput) {
  const e = await load(id);
  assertView(a, e.startupId);
  assertApprove(a);
  if (e.startupId) throw new AppError(400, "Only central DevUp costs are shared between startups", "NOT_CENTRAL");
  if (["VOID", "REJECTED"].includes(e.status)) throw new AppError(409, "This expense is not live", "WRONG_STATUS");
  if (e.kind === "ADJUSTMENT") throw new AppError(400, "Share the original expense, not its correction", "ADJUSTMENT");

  const shares = input.shares ?? [];
  const targets = shares.map((s) => scopeFrom(s.scope));
  if (new Set(targets.map((t) => t ?? "central")).size !== targets.length) throw new AppError(400, "Each startup can appear only once", "DUPLICATE_SHARE");
  const startupIds = targets.filter((t): t is string => !!t);
  if (startupIds.length) {
    const found = await prisma.startup.count({ where: { id: { in: startupIds } } });
    if (found !== startupIds.length) throw new AppError(400, "One of those startups doesn't exist", "UNKNOWN_STARTUP");
  }

  let amounts: number[] = [];
  let basis: Array<number | null> = [];
  if (shares.length) {
    switch (input.method) {
      case "PERCENT": {
        const bp = shares.map((s) => Math.round(Number(s.percent) * 100));
        if (bp.some((x) => !Number.isFinite(x) || x <= 0)) throw new AppError(400, "Every percentage must be more than 0", "INVALID_ALLOCATION");
        if (bp.reduce((x, y) => x + y, 0) !== 10000) throw new AppError(400, "The percentages must add up to exactly 100%", "ALLOCATION_NOT_100");
        amounts = splitByWeights(e.amountPaise, bp);
        basis = bp;
        break;
      }
      case "FIXED":
      case "CUSTOM": {
        amounts = shares.map((s) => rupeesToPaise(s.amount));
        const sum = amounts.reduce((x, y) => x + y, 0);
        if (sum !== e.amountPaise) throw new AppError(400, `The shares add up to ₹${sum / 100}, but the expense is ₹${e.amountPaise / 100}`, "ALLOCATION_MISMATCH");
        basis = shares.map(() => null);
        break;
      }
      case "HEADCOUNT": {
        const hc = await headcounts(startupIds);
        const w = targets.map((t) => (t ? hc.get(t) ?? 0 : 0));
        if (w.every((x) => x === 0)) throw new AppError(400, "None of those startups has anyone working there right now — choose another way to split", "NO_HEADCOUNT");
        amounts = splitByWeights(e.amountPaise, w);
        basis = w;
        break;
      }
      case "USAGE": {
        const u = shares.map((s) => Number(s.units));
        if (u.some((x) => !Number.isFinite(x) || x < 0)) throw new AppError(400, "Usage must be a number of units", "INVALID_ALLOCATION");
        amounts = splitByWeights(e.amountPaise, u.map((x) => Math.round(x * 100)));
        basis = u.map((x) => Math.round(x * 100));
        break;
      }
      default:
        throw new AppError(400, "Choose how to split the cost", "INVALID_ALLOCATION");
    }
  }

  const before = e.allocations.map((x) => ({ startupId: x.startupId, amountPaise: x.amountPaise, method: x.method }));
  await prisma.$transaction(async (tx) => {
    await tx.expenseAllocation.deleteMany({ where: { expenseId: id } });
    if (shares.length) {
      await tx.expenseAllocation.createMany({
        data: targets.map((t, i) => ({ expenseId: id, startupId: t, method: input.method, basis: basis[i], amountPaise: amounts[i], note: input.note?.trim() || null, createdBy: a.userId })),
      });
    }
    await audit({ action: shares.length ? "finance.expense.split" : "finance.expense.split_cleared", entity: ENTITY, entityId: id, actorId: a.userId, metadata: { method: input.method, before, after: targets.map((t, i) => ({ startupId: t, amountPaise: amounts[i] })) } }, tx);
  });
  return getExpense(a, id);
}

/* Receipts and proofs */

export async function addAttachment(a: FinanceAccess, id: string, file: { buffer: Buffer; originalname?: string } | undefined, kind = "RECEIPT") {
  const e = await load(id);
  const isClaimant = e.claimantUserId === a.userId;
  if (!isClaimant) assertManage(a, e.startupId);
  if (e.status === "PAID" && !a.isCfo) throw new AppError(403, "Only the CFO can add files to a paid expense", "NOT_EDITABLE");
  if (e.status === "VOID") throw new AppError(409, "This expense was voided", "WRONG_STATUS");
  const f = verifyUpload(file, "identity");
  const allowedKinds = ["RECEIPT", "INVOICE", "PAYMENT_PROOF", "OTHER"];
  const k = allowedKinds.includes(kind) ? kind : "RECEIPT";
  const path = objectKey(["expenses", e.startupId ?? "central", e.id], k.toLowerCase(), f.ext);
  const storagePath = await uploadPrivateFile(FINANCE_BUCKET(), path, f.buffer, f.mime);
  const att = await prisma.$transaction(async (tx) => {
    const row = await tx.financeAttachment.create({
      data: { entity: ENTITY, entityId: e.id, startupId: e.startupId, kind: k, fileName: f.displayName, mimeType: f.mime, sizeBytes: f.size, storagePath, uploadedBy: a.userId },
    });
    await audit({ action: "finance.expense.file_added", entity: ENTITY, entityId: e.id, actorId: a.userId, startupId: e.startupId ?? undefined, metadata: { attachmentId: row.id, kind: k, fileName: f.displayName } }, tx);
    return row;
  });
  const { storagePath: _p, ...out } = att;
  return out;
}

/** A link valid for five minutes. Never a public URL. */
export async function attachmentLink(a: FinanceAccess, attachmentId: string) {
  const att = await prisma.financeAttachment.findFirst({ where: { id: attachmentId, deletedAt: null } });
  if (!att) throw new AppError(404, "Not found", "NOT_FOUND");
  if (att.entity === ENTITY) {
    const e = await prisma.expense.findUnique({ where: { id: att.entityId }, select: { startupId: true, claimantUserId: true } });
    if (!e) throw new AppError(404, "Not found", "NOT_FOUND");
    if (e.claimantUserId !== a.userId) assertView(a, e.startupId);
  } else {
    assertView(a, att.startupId);
  }
  const url = await signedUrl(FINANCE_BUCKET(), att.storagePath, 300);
  if (!url) throw new AppError(502, "The file could not be opened. Try again.", "FILE_UNAVAILABLE");
  await audit({ action: "finance.file.opened", entity: "FinanceAttachment", entityId: att.id, actorId: a.userId, startupId: att.startupId ?? undefined });
  return { url, expiresInSeconds: 300, fileName: att.fileName, mimeType: att.mimeType };
}

/* Reimbursement claims by staff */

/** Startups where this person works: an active employee or intern record, or an active membership. */
export async function myStartups(userId: string) {
  const [emp, int, mem] = await Promise.all([
    prisma.employee.findMany({ where: { userId, status: { in: ["ACTIVE", "NOTICE"] } }, select: { startup: { select: { id: true, name: true, code: true } } } }),
    prisma.intern.findMany({ where: { userId, status: { in: ["ACTIVE", "NOTICE"] } }, select: { startup: { select: { id: true, name: true, code: true } } } }),
    prisma.startupMember.findMany({ where: { userId, status: "ACTIVE" }, select: { startup: { select: { id: true, name: true, code: true } } } }),
  ]);
  const map = new Map<string, { id: string; name: string; code: string | null }>();
  for (const r of [...emp, ...int, ...mem]) map.set(r.startup.id, r.startup);
  return [...map.values()];
}

export async function submitClaim(userId: string, input: Omit<ExpenseInput, "kind" | "action" | "paymentRef" | "paidOn"> & { draft?: boolean }) {
  const startups = await myStartups(userId);
  const startupId = scopeFrom(input.scope);
  if (!startupId || !startups.some((s) => s.id === startupId)) throw new AppError(403, "You can only claim expenses for a startup you work at", "NOT_YOUR_STARTUP");
  if (!input.businessPurpose?.trim()) throw new AppError(400, "Say what the expense was for", "PURPOSE_REQUIRED");
  const data = await cleanInput(input);
  if (!data.categoryId || data.amountPaise === undefined || !data.incurredOn || !data.title) throw new AppError(400, "Title, category, amount and date are required", "MISSING_FIELDS");
  return prisma.$transaction(async (tx) => {
    const number = await nextExpenseNumber(tx, startupId, data.incurredOn as Date);
    const status: ExpenseStatus = input.draft ? "DRAFT" : "SUBMITTED";
    const e = await tx.expense.create({
      data: { ...(data as Prisma.ExpenseUncheckedCreateInput), number, startupId, kind: "REIMBURSEMENT", status, claimantUserId: userId, submittedBy: userId, submittedAt: status === "SUBMITTED" ? new Date() : null } as Prisma.ExpenseUncheckedCreateInput,
    });
    await audit({ action: "finance.claim.created", entity: ENTITY, entityId: e.id, actorId: userId, startupId, metadata: { number, status, amountPaise: e.amountPaise } }, tx);
    return e;
  });
}

export async function myClaims(userId: string) {
  return prisma.expense.findMany({
    where: { claimantUserId: userId, deletedAt: null },
    include: { category: { select: { name: true } }, startup: { select: { name: true, code: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export { LIVE as LIVE_STATUSES };
