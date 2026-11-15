import { randomBytes } from "crypto";
import { FinanceInvoiceStatus, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { notify } from "../shared/notification.service";
import { esc, renderEmail, details } from "../../lib/email/layout";
import { fiscalYear } from "../../lib/numbering";
import { FinanceAccess, assertApprove, canView } from "./access";
import { dateOnly, parseDate, rupeesToPaise } from "./money";

/**
 * Bills from central DevUp to its startups — shared rent, tools, staff,
 * collaboration costs — and the money startups pay against them.
 *
 *   DRAFT → ISSUED → PART_PAID → PAID          (CANCELLED from DRAFT/ISSUED)
 *   Overdue is worked out from the due date, never stored.
 *   DISPUTED / UNDER_RECONCILIATION pause reminders until cleared.
 *
 * These are internal: a startup paying DevUp moves money inside the
 * ecosystem. It is reported as "collected from startups", never as DevUp
 * revenue, and the costs it recovers were already counted once as expenses.
 *
 * Reminders are limited: by hand at most once a day per bill; automatically
 * (daily job) only when overdue, at most every 7 days, and never more than the
 * bill's maxReminders. Each one records what happened to the email.
 */

const ENTITY = "FinanceInvoice";
const OPEN: FinanceInvoiceStatus[] = ["ISSUED", "PART_PAID"];
const AUTO_GAP_DAYS = 7;
const MANUAL_GAP_HOURS = 24;

const include = {
  recipient: { select: { id: true, name: true, code: true } },
  receipts: { orderBy: { receivedOn: "asc" as const } },
  reminders: { orderBy: { createdAt: "desc" as const }, take: 20 },
} satisfies Prisma.FinanceInvoiceInclude;
type InvoiceRow = Prisma.FinanceInvoiceGetPayload<{ include: typeof include }>;

function present(i: InvoiceRow) {
  const today = dateOnly(new Date());
  const outstanding = i.amountPaise - i.receivedPaise;
  const { viewToken, ...rest } = i;
  return {
    ...rest,
    outstandingPaise: OPEN.includes(i.status) ? outstanding : 0,
    isOverdue: OPEN.includes(i.status) && !!i.dueDate && i.dueDate < today,
    viewUrl: `${env.FRONTEND_URL ?? "https://www.devupecosystem.com"}/bill/${viewToken}`,
  };
}

/** Central sees all bills; a startup's finance people see the bills addressed to their startup. */
function visible(a: FinanceAccess, i: { recipientStartupId: string }) {
  return a.viewAll || canView(a, i.recipientStartupId);
}

async function load(id: string) {
  const i = await prisma.financeInvoice.findUnique({ where: { id }, include });
  if (!i) throw new AppError(404, "Not found", "NOT_FOUND");
  return i;
}

/* Reading */

export async function listInvoices(a: FinanceAccess, q: { scope?: string; status?: FinanceInvoiceStatus; overdue?: boolean }) {
  const startup = q.scope && q.scope !== "all" && q.scope !== "central" ? q.scope : undefined;
  if (startup && !canView(a, startup)) throw new AppError(404, "Not found", "NOT_FOUND");
  const rows = await prisma.financeInvoice.findMany({
    where: {
      // A startup's finance people see only bills addressed to their startups.
      ...(startup ? { recipientStartupId: startup } : a.viewAll ? {} : { recipientStartupId: { in: [...a.viewStartups] } }),
      ...(q.status ? { status: q.status } : {}),
      ...(q.overdue ? { status: { in: OPEN }, dueDate: { lt: dateOnly(new Date()) } } : {}),
    },
    include,
    orderBy: [{ createdAt: "desc" }],
    take: 300,
  });
  const list = rows.map(present);
  return {
    invoices: list,
    totals: {
      outstandingPaise: list.reduce((s, i) => s + i.outstandingPaise, 0),
      overduePaise: list.filter((i) => i.isOverdue).reduce((s, i) => s + i.outstandingPaise, 0),
      overdueCount: list.filter((i) => i.isOverdue).length,
    },
  };
}

export async function getInvoice(a: FinanceAccess, id: string) {
  const i = await load(id);
  if (!visible(a, i)) throw new AppError(404, "Not found", "NOT_FOUND");
  const history = await prisma.auditLog.findMany({ where: { entity: ENTITY, entityId: id }, orderBy: { createdAt: "asc" } });
  return { ...present(i), history: history.map((h) => ({ at: h.createdAt, action: h.action, by: h.adminId, details: h.metadata })) };
}

/** What a startup owes, for the dashboard: open bills' outstanding amount. */
export async function expectedFromStartups(a: FinanceAccess, scope?: string) {
  const startup = scope && scope !== "all" && scope !== "central" ? scope : undefined;
  if (startup && !canView(a, startup)) return null;
  if (!startup && !a.viewAll) return null;
  const rows = await prisma.financeInvoice.findMany({ where: { status: { in: OPEN }, ...(startup ? { recipientStartupId: startup } : {}) }, select: { amountPaise: true, receivedPaise: true } });
  return rows.length ? rows.reduce((s, r) => s + r.amountPaise - r.receivedPaise, 0) : null;
}

/* Writing — the CFO */

export type InvoiceInput = {
  recipientStartupId: string;
  title: string;
  description?: string | null;
  lines: Array<{ label: string; amount: string | number }>;
  dueDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  billingEmail?: string | null;
  maxReminders?: number;
};

function cleanLines(lines: InvoiceInput["lines"]) {
  if (!lines?.length) throw new AppError(400, "Add at least one line to the bill", "LINES_REQUIRED");
  if (lines.length > 50) throw new AppError(400, "Up to 50 lines", "TOO_MANY");
  const out = lines.map((l) => {
    const label = String(l.label ?? "").trim();
    if (label.length < 2) throw new AppError(400, "Describe each line", "LABEL_REQUIRED");
    return { label: label.slice(0, 200), amountPaise: rupeesToPaise(l.amount) };
  });
  return { lines: out, amountPaise: out.reduce((s, l) => s + l.amountPaise, 0) };
}

async function nextInvoiceNumber(tx: Prisma.TransactionClient, on: Date) {
  const key = `INV:DEV:${fiscalYear(on)}`;
  const seq = await tx.financeSequence.upsert({ where: { key }, create: { key, current: 1 }, update: { current: { increment: 1 } } });
  return `INV-DEV-${fiscalYear(on)}-${String(seq.current).padStart(4, "0")}`;
}

export async function createInvoice(a: FinanceAccess, input: InvoiceInput) {
  assertApprove(a);
  const s = await prisma.startup.findUnique({ where: { id: input.recipientStartupId }, select: { id: true } });
  if (!s) throw new AppError(404, "Not found", "NOT_FOUND");
  const { lines, amountPaise } = cleanLines(input.lines);
  if (input.title?.trim().length < 2) throw new AppError(400, "Give the bill a title", "TITLE_REQUIRED");
  const email = input.billingEmail?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, "That email address isn't valid", "INVALID_EMAIL");
  const inv = await prisma.$transaction(async (tx) => {
    const number = await nextInvoiceNumber(tx, new Date());
    const row = await tx.financeInvoice.create({
      data: {
        number, recipientStartupId: s.id, title: input.title.trim().slice(0, 200), description: input.description?.trim() || null,
        lines: lines as unknown as Prisma.InputJsonValue, amountPaise, dueDate: input.dueDate ? parseDate(input.dueDate, "due date") : null,
        periodStart: input.periodStart ? parseDate(input.periodStart) : null, periodEnd: input.periodEnd ? parseDate(input.periodEnd) : null,
        billingEmail: email, maxReminders: Math.min(Math.max(input.maxReminders ?? 4, 0), 10),
        viewToken: randomBytes(24).toString("base64url"), createdBy: a.userId,
      },
    });
    await audit({ action: "finance.invoice.created", entity: ENTITY, entityId: row.id, actorId: a.userId, startupId: s.id, metadata: { number, amountPaise } }, tx);
    return row;
  });
  return getInvoice(a, inv.id);
}

/** Lines for a startup's share of central costs in a period — to start a bill from. Saves nothing. */
export async function suggestFromSharedCosts(a: FinanceAccess, startupId: string, from: string, to: string) {
  assertApprove(a);
  const shares = await prisma.expenseAllocation.findMany({
    where: { startupId, expense: { deletedAt: null, startupId: null, status: { in: ["APPROVED", "PAID"] }, incurredOn: { gte: parseDate(from), lte: parseDate(to) } } },
    include: { expense: { select: { number: true, title: true } } },
    orderBy: { createdAt: "asc" },
  });
  return shares.map((s) => ({ label: `${s.expense.title} (${s.expense.number})`, amount: (s.amountPaise / 100).toFixed(2) }));
}

async function transition(a: FinanceAccess, id: string, args: { from: FinanceInvoiceStatus[]; data: Prisma.FinanceInvoiceUncheckedUpdateInput; action: string; metadata?: Record<string, unknown> }) {
  assertApprove(a);
  const i = await load(id);
  if (!args.from.includes(i.status)) throw new AppError(409, `This bill is ${i.status.toLowerCase().replace("_", " ")}`, "WRONG_STATUS");
  await prisma.$transaction(async (tx) => {
    const n = await tx.financeInvoice.updateMany({ where: { id, status: i.status }, data: args.data });
    if (n.count !== 1) throw new AppError(409, "Someone else just changed this bill. Reload and try again.", "CONFLICT");
    await audit({ action: `finance.invoice.${args.action}`, entity: ENTITY, entityId: id, actorId: a.userId, startupId: i.recipientStartupId, metadata: { from: i.status, ...args.metadata } }, tx);
  });
  return getInvoice(a, id);
}

export function issueInvoice(a: FinanceAccess, id: string, input: { dueDate?: string | null }) {
  const today = dateOnly(new Date());
  const due = input.dueDate ? parseDate(input.dueDate, "due date") : new Date(today.getTime() + 15 * 86400_000);
  return transition(a, id, { from: ["DRAFT"], data: { status: "ISSUED", issueDate: today, dueDate: due }, action: "issued", metadata: { dueDate: due } });
}

export function cancelInvoice(a: FinanceAccess, id: string, reason: string) {
  if (!reason?.trim()) throw new AppError(400, "Say why the bill is cancelled", "REASON_REQUIRED");
  return transition(a, id, { from: ["DRAFT", "ISSUED"], data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.trim() }, action: "cancelled", metadata: { reason } });
}

/** Mark disputed or under reconciliation (pauses reminders), or clear it (flag null). */
export async function flagInvoice(a: FinanceAccess, id: string, input: { flag: "DISPUTED" | "UNDER_RECONCILIATION" | null; note?: string | null }) {
  assertApprove(a);
  const i = await load(id);
  if (input.flag && !input.note?.trim()) throw new AppError(400, "Say what's disputed or being checked", "NOTE_REQUIRED");
  await prisma.$transaction(async (tx) => {
    await tx.financeInvoice.update({ where: { id }, data: { flag: input.flag, flagNote: input.flag ? input.note!.trim() : null } });
    await audit({ action: input.flag ? "finance.invoice.flagged" : "finance.invoice.flag_cleared", entity: ENTITY, entityId: id, actorId: a.userId, startupId: i.recipientStartupId, metadata: { flag: input.flag, note: input.note ?? null } }, tx);
  });
  return getInvoice(a, id);
}

/* Receipts */

const statusFor = (amount: number, received: number): FinanceInvoiceStatus => (received <= 0 ? "ISSUED" : received >= amount ? "PAID" : "PART_PAID");

export async function recordReceipt(a: FinanceAccess, id: string, input: { amount: string | number; receivedOn: string; method?: PaymentMethod | null; reference?: string | null; note?: string | null }) {
  assertApprove(a);
  const i = await load(id);
  if (!OPEN.includes(i.status)) throw new AppError(409, "Payments are recorded against an issued bill", "WRONG_STATUS");
  const amount = rupeesToPaise(input.amount);
  const ref = input.reference?.trim() || null;
  if (ref && i.receipts.some((r) => !r.reversedAt && r.reference === ref)) throw new AppError(409, `A payment with reference ${ref} is already recorded on this bill`, "DUPLICATE_RECEIPT");
  if (i.receivedPaise + amount > i.amountPaise) throw new AppError(400, `That's more than the ₹${(i.amountPaise - i.receivedPaise) / 100} still owed`, "OVERPAYMENT");
  await prisma.$transaction(async (tx) => {
    const r = await tx.invoiceReceipt.create({ data: { invoiceId: id, amountPaise: amount, receivedOn: parseDate(input.receivedOn, "payment date"), method: input.method ?? null, reference: ref, note: input.note?.trim() || null, recordedBy: a.userId } });
    const received = i.receivedPaise + amount;
    const n = await tx.financeInvoice.updateMany({ where: { id, receivedPaise: i.receivedPaise }, data: { receivedPaise: received, status: statusFor(i.amountPaise, received) } });
    if (n.count !== 1) throw new AppError(409, "Another payment was just recorded. Reload and try again.", "CONFLICT");
    await audit({ action: "finance.invoice.payment_recorded", entity: ENTITY, entityId: id, actorId: a.userId, startupId: i.recipientStartupId, metadata: { receiptId: r.id, amountPaise: amount, reference: ref } }, tx);
  });
  return getInvoice(a, id);
}

export async function reverseReceipt(a: FinanceAccess, id: string, receiptId: string, reason: string) {
  assertApprove(a);
  if (!reason?.trim()) throw new AppError(400, "Say why the payment is reversed", "REASON_REQUIRED");
  const i = await load(id);
  const r = i.receipts.find((x) => x.id === receiptId);
  if (!r || r.reversedAt) throw new AppError(404, "Not found", "NOT_FOUND");
  await prisma.$transaction(async (tx) => {
    await tx.invoiceReceipt.update({ where: { id: receiptId }, data: { reversedAt: new Date(), reversedBy: a.userId, reverseReason: reason.trim() } });
    const received = i.receivedPaise - r.amountPaise;
    await tx.financeInvoice.update({ where: { id }, data: { receivedPaise: received, status: statusFor(i.amountPaise, received) } });
    await audit({ action: "finance.invoice.payment_reversed", entity: ENTITY, entityId: id, actorId: a.userId, startupId: i.recipientStartupId, metadata: { receiptId, amountPaise: r.amountPaise, reason } }, tx);
  });
  return getInvoice(a, id);
}

/* Reminders */

async function recipients(i: InvoiceRow) {
  if (i.billingEmail) return [i.billingEmail];
  const members = await prisma.startupMember.findMany({ where: { startupId: i.recipientStartupId, status: "ACTIVE", role: { in: ["OWNER", "FOUNDER"] } }, select: { email: true } });
  return [...new Set(members.map((m) => m.email.toLowerCase()))];
}

function reminderHtml(i: InvoiceRow, level: number) {
  const p = present(i);
  const money = (n: number) => `₹${(n / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const tone = level >= 3 ? "This bill is now well past its due date. Please pay it or tell us if something is wrong." : p.isOverdue ? "This bill is past its due date." : "A friendly reminder about this bill.";
  return renderEmail({
    preheader: `${i.number}: ${money(p.outstandingPaise)} outstanding`,
    heading: `Bill ${i.number} from DevUp`,
    body: `<p style="margin:0 0 14px;">${esc(tone)}</p>${details([
      ["For", i.recipient.name], ["Bill", `${i.title} (${i.number})`], ["Total", money(i.amountPaise)], ["Paid so far", money(i.receivedPaise)],
      ["Still owed", money(p.outstandingPaise)], ["Due", i.dueDate ? i.dueDate.toISOString().slice(0, 10) : "—"],
    ])}`,
    cta: { label: "View the bill", url: p.viewUrl },
    footnote: "If you've already paid, reply with the payment reference and we'll match it.",
    fromOrg: "DevUp Ecosystem — Finance",
  });
}

/** Send one reminder now. Limited to one a day per bill, not while disputed, not past maxReminders. */
export async function sendReminder(i: InvoiceRow, sentBy: string, automatic: boolean) {
  if (!OPEN.includes(i.status)) throw new AppError(409, "Only an unpaid, issued bill gets reminders", "WRONG_STATUS");
  if (i.flag) throw new AppError(409, `This bill is marked ${i.flag === "DISPUTED" ? "disputed" : "under reconciliation"} — reminders are paused`, "FLAGGED");
  if (i.reminderCount >= i.maxReminders) throw new AppError(409, `The limit of ${i.maxReminders} reminders for this bill has been reached`, "REMINDER_LIMIT");
  if (i.lastReminderAt && Date.now() - i.lastReminderAt.getTime() < MANUAL_GAP_HOURS * 3600_000) throw new AppError(409, "A reminder already went out in the last 24 hours", "TOO_SOON");
  const to = await recipients(i);
  if (!to.length) throw new AppError(409, "No one to send it to — add a billing email or a founder to the startup", "NO_RECIPIENT");
  const level = i.reminderCount + 1;
  const html = reminderHtml(i, level);
  let delivered = "SENT";
  let error: string | null = null;
  for (const email of to) {
    const out = await notify({ email, event: "FINANCE_PAYMENT_REMINDER", title: `Reminder: bill ${i.number} from DevUp`, message: `Bill ${i.number} has an outstanding balance.`, html });
    if (out.email === "failed") { delivered = "FAILED"; error = out.error ?? "SEND_FAILED"; }
    else if (out.email === "queued" && delivered !== "FAILED") delivered = "QUEUED";
    else if (out.email === "skipped" && delivered === "SENT") delivered = "SKIPPED";
  }
  await prisma.$transaction(async (tx) => {
    await tx.paymentReminder.create({ data: { invoiceId: i.id, sentTo: to.join(", "), sentBy, automatic, level, delivery: delivered, error } });
    await tx.financeInvoice.update({ where: { id: i.id }, data: { reminderCount: { increment: 1 }, lastReminderAt: new Date() } });
    await audit({ action: "finance.invoice.reminder_sent", entity: ENTITY, entityId: i.id, actorId: sentBy, startupId: i.recipientStartupId, metadata: { level, automatic, delivery: delivered, error, recipients: to.length } }, tx);
  });
  return { level, delivery: delivered, error };
}

export async function remindNow(a: FinanceAccess, id: string) {
  assertApprove(a);
  const result = await sendReminder(await load(id), a.userId, false);
  return { ...result, invoice: await getInvoice(a, id) };
}

/** Daily job: overdue bills, not flagged, under the limit, nothing sent for 7 days. */
export async function automaticReminders(now = new Date()) {
  const today = dateOnly(now);
  const due = await prisma.financeInvoice.findMany({
    where: { status: { in: OPEN }, flag: null, dueDate: { lt: today }, OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: new Date(now.getTime() - AUTO_GAP_DAYS * 86400_000) } }] },
    include,
  });
  let sent = 0;
  for (const i of due) {
    if (i.reminderCount >= i.maxReminders) continue;
    try { await sendReminder(i, "system:reminders", true); sent++; } catch { /* one bill's problem never stops the others */ }
  }
  return sent;
}

/* The startup's view, by link */

export async function publicInvoice(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new AppError(404, "Not found", "NOT_FOUND");
  const i = await prisma.financeInvoice.findUnique({ where: { viewToken: token }, include });
  if (!i || i.status === "DRAFT") throw new AppError(404, "Not found", "NOT_FOUND");
  const p = present(i);
  return {
    number: i.number, title: i.title, description: i.description, recipient: i.recipient.name, lines: i.lines, amountPaise: i.amountPaise,
    receivedPaise: i.receivedPaise, outstandingPaise: p.outstandingPaise, issueDate: i.issueDate, dueDate: i.dueDate, status: i.status, isOverdue: p.isOverdue,
    periodStart: i.periodStart, periodEnd: i.periodEnd,
    payments: i.receipts.filter((r) => !r.reversedAt).map((r) => ({ amountPaise: r.amountPaise, receivedOn: r.receivedOn, reference: r.reference })),
  };
}
