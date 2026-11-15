import { Prisma, RecurringFrequency } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { FinanceAccess, assertManage, assertView, canView, scopeWhere } from "./access";
import { dateOnly, parseDate, rupeesToPaise } from "./money";
import { nextExpenseNumber } from "./expenses.service";
import { dueDates, isoDate, utc } from "./recurringDates";

export { dueDates };

/**
 * Bills that come back on a schedule: rent, electricity, internet, housekeeping.
 *
 * Each due date becomes ONE expense, `leadDays` before it is due. A unique
 * (bill, due date) row makes this safe to run any number of times — by the
 * daily job, by the CFO's button, or both at once.
 *
 *   autoApprove  a fixed bill the CFO set up (rent) is created already
 *                approved, ready to pay; anything else waits for approval.
 *   amount       variable bills (electricity) are created with the usual
 *                amount and corrected to the real bill before approval.
 *
 * Only due dates from the last 60 days onward are created, so switching a
 * bill on never floods the books with years of back-dated expenses.
 */

const ENTITY = "FinanceRecurringBill";
const CATCH_UP_DAYS = 60;
const SYSTEM = "system:recurring";

export type RecurringBillInput = {
  scope: string;
  title: string;
  categoryId: string;
  vendorId?: string | null;
  payee?: string | null;
  amount: string | number;
  frequency?: RecurringFrequency;
  dueDay: number;
  startsOn: string;
  endsOn?: string | null;
  leadDays?: number;
  autoApprove?: boolean;
  notes?: string | null;
};

const iso = isoDate;

type BillData = Prisma.RecurringBillUncheckedUpdateInput;

async function validate(a: FinanceAccess, input: Partial<RecurringBillInput>, existing?: { startupId: string | null }) {
  const data: BillData = {};
  checkScope(a, input, data, existing);
  await checkWhat(input, data);
  checkSchedule(input, data);
  checkApproval(a, input, data);
  return data;
}

function checkScope(a: FinanceAccess, input: Partial<RecurringBillInput>, data: BillData, existing?: { startupId: string | null }) {
  if (input.scope !== undefined) {
    const startupId = input.scope === "central" ? null : input.scope;
    assertManage(a, startupId);
    data.startupId = startupId;
  } else if (existing) {
    assertManage(a, existing.startupId);
  }
}

async function checkWhat(input: Partial<RecurringBillInput>, data: BillData) {
  if (input.title !== undefined) {
    if (input.title.trim().length < 2) throw new AppError(400, "Give the bill a name", "TITLE_REQUIRED");
    data.title = input.title.trim().slice(0, 160);
  }
  if (input.categoryId !== undefined) {
    const c = await prisma.financeCategory.findFirst({ where: { id: input.categoryId, isActive: true } });
    if (!c) throw new AppError(400, "Choose a category", "CATEGORY_REQUIRED");
    data.categoryId = c.id;
  }
  if (input.vendorId !== undefined) data.vendorId = input.vendorId || null;
  if (input.payee !== undefined) data.payee = input.payee?.trim() || null;
  if (input.amount !== undefined) data.amountPaise = rupeesToPaise(input.amount);
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
}

function checkSchedule(input: Partial<RecurringBillInput>, data: BillData) {
  if (input.frequency !== undefined) data.frequency = input.frequency;
  if (input.dueDay !== undefined) data.dueDay = input.dueDay;
  if (input.startsOn !== undefined) data.startsOn = parseDate(input.startsOn, "start date");
  if (input.endsOn !== undefined) data.endsOn = input.endsOn ? parseDate(input.endsOn, "end date") : null;
  if (input.leadDays === undefined) return;
  if (!Number.isInteger(input.leadDays) || input.leadDays < 0 || input.leadDays > 30) throw new AppError(400, "Create the bill between 0 and 30 days before it's due", "INVALID_LEAD_DAYS");
  data.leadDays = input.leadDays;
}

function checkApproval(a: FinanceAccess, input: Partial<RecurringBillInput>, data: BillData) {
  if (input.autoApprove === undefined) return;
  if (input.autoApprove && !a.isCfo) throw new AppError(403, "Only the CFO can set a bill to be approved automatically", "CFO_ONLY");
  data.autoApprove = input.autoApprove;
}

function checkDay(frequency: RecurringFrequency, dueDay: number) {
  const max = frequency === "WEEKLY" ? 7 : 28;
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > max) {
    throw new AppError(400, frequency === "WEEKLY" ? "Choose a weekday (1 = Monday … 7 = Sunday)" : "Choose a due day from 1 to 28 (every month has those)", "INVALID_DUE_DAY");
  }
}

const include = {
  startup: { select: { id: true, name: true, code: true } },
  runs: { orderBy: { dueDate: "desc" as const }, take: 3 },
} satisfies Prisma.RecurringBillInclude;

export async function listBills(a: FinanceAccess, scope?: string) {
  const bills = await prisma.recurringBill.findMany({ where: { ...scopeWhere(a, scope) }, include, orderBy: [{ isActive: "desc" }, { title: "asc" }] });
  const today = dateOnly(new Date());
  const yearAhead = utc(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate());
  const expenseIds = bills.flatMap((b) => b.runs.map((r) => r.expenseId));
  const expenses = await prisma.expense.findMany({ where: { id: { in: expenseIds } }, select: { id: true, number: true, status: true, amountPaise: true } });
  const byId = new Map(expenses.map((e) => [e.id, e]));
  return bills.map((b) => ({
    ...b,
    nextDue: b.isActive ? dueDates(b, today, yearAhead)[0] ?? null : null,
    recent: b.runs.map((r) => ({ dueDate: r.dueDate, expense: byId.get(r.expenseId) ?? null })),
  }));
}

export async function createBill(a: FinanceAccess, input: RecurringBillInput) {
  const data = await validate(a, input);
  const frequency = input.frequency ?? "MONTHLY";
  checkDay(frequency, input.dueDay);
  if (!data.categoryId || data.amountPaise === undefined || !data.title || !data.startsOn) throw new AppError(400, "Name, category, amount and start date are required", "MISSING_FIELDS");
  const bill = await prisma.$transaction(async (tx) => {
    const row = await tx.recurringBill.create({ data: { ...(data as Prisma.RecurringBillUncheckedCreateInput), frequency, createdBy: a.userId } });
    await audit({ action: "finance.recurring.created", entity: ENTITY, entityId: row.id, actorId: a.userId, startupId: row.startupId ?? undefined, metadata: { title: row.title, amountPaise: row.amountPaise, frequency, dueDay: row.dueDay, autoApprove: row.autoApprove } }, tx);
    return row;
  });
  return bill;
}

export async function updateBill(a: FinanceAccess, id: string, input: Partial<RecurringBillInput> & { isActive?: boolean }) {
  const bill = await prisma.recurringBill.findUnique({ where: { id } });
  if (!bill) throw new AppError(404, "Not found", "NOT_FOUND");
  assertView(a, bill.startupId);
  const data = await validate(a, input, bill);
  if (input.isActive !== undefined) data.isActive = input.isActive;
  checkDay((data.frequency as RecurringFrequency) ?? bill.frequency, (data.dueDay as number) ?? bill.dueDay);
  const changes = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { from: (bill as any)[k], to: v }]));
  await prisma.$transaction(async (tx) => {
    await tx.recurringBill.update({ where: { id }, data });
    await audit({ action: "finance.recurring.edited", entity: ENTITY, entityId: id, actorId: a.userId, startupId: bill.startupId ?? undefined, metadata: { changes } }, tx);
  });
  return prisma.recurringBill.findUnique({ where: { id }, include });
}

/** Create the expenses for every due date that has come within reach. Safe to repeat. */
export async function generateDue(opts: { today?: Date; actorId?: string; scopeFilter?: (startupId: string | null) => boolean } = {}) {
  const today = dateOnly(opts.today ?? new Date());
  const floor = utc(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - CATCH_UP_DAYS);
  const bills = await prisma.recurringBill.findMany({ where: { isActive: true } });
  const created: Array<{ billId: string; dueDate: string; expenseId: string; number: string }> = [];
  for (const bill of bills) {
    if (opts.scopeFilter && !opts.scopeFilter(bill.startupId)) continue;
    const until = utc(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + bill.leadDays);
    for (const due of dueDates(bill, floor, until)) {
      const made = await createRun(bill, due, today, opts.actorId ?? SYSTEM);
      if (made) created.push(made);
    }
  }
  return { created, checked: bills.length };
}

async function createRun(bill: Prisma.RecurringBillGetPayload<object>, due: Date, today: Date, actor: string) {
  const dueDate = iso(due);
  const exists = await prisma.recurringBillRun.findUnique({ where: { billId_dueDate: { billId: bill.id, dueDate } } });
  if (exists) return null;
  const label = due.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  try {
    return await prisma.$transaction(async (tx) => {
      const incurredOn = due < today ? due : today;
      const number = await nextExpenseNumber(tx, bill.startupId, incurredOn);
      const approved = bill.autoApprove;
      const e = await tx.expense.create({
        data: {
          number, startupId: bill.startupId, kind: "VENDOR_BILL", title: `${bill.title} — ${label}`, categoryId: bill.categoryId,
          vendorId: bill.vendorId, payee: bill.payee, amountPaise: bill.amountPaise, incurredOn, dueOn: due,
          status: approved ? "APPROVED" : "SUBMITTED", submittedBy: actor, submittedAt: new Date(),
          // Auto-approval is a standing approval the CFO gave when setting the bill up.
          ...(approved ? { approvedBy: bill.createdBy, approvedAt: new Date(), reviewNote: "Approved automatically: recurring bill set up by the CFO" } : {}),
          source: "RECURRING_BILL", sourceId: bill.id, notes: bill.notes,
        },
      });
      await tx.recurringBillRun.create({ data: { billId: bill.id, dueDate, expenseId: e.id } });
      await audit({ action: "finance.expense.created", entity: "FinanceExpense", entityId: e.id, actorId: actor, startupId: bill.startupId ?? undefined, metadata: { number, status: e.status, amountPaise: e.amountPaise, source: "RECURRING_BILL", sourceId: bill.id, dueDate } }, tx);
      return { billId: bill.id, dueDate, expenseId: e.id, number };
    });
  } catch (err) {
    // Another run created the same (bill, due date) at the same moment: that one stands.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

/** The CFO's "create due bills now" button, limited to what they can manage. */
export async function generateNow(a: FinanceAccess) {
  if (!a.isCfo && a.manageStartups.size === 0) throw new AppError(403, "You can view these records but not change them", "FINANCE_READ_ONLY");
  return generateDue({ actorId: a.userId, scopeFilter: (s) => (a.isCfo ? true : s !== null && a.manageStartups.has(s) && canView(a, s)) });
}
