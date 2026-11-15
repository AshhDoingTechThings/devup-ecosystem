import { PayrollKind, PayrollRunStatus, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { open as unseal } from "../../lib/secrets";
import { computeFor } from "../hrms/finance/stipend.service";
import { FinanceAccess, assertApprove } from "./access";
import { parseDate, rupeesToPaise } from "./money";
import { nextExpenseNumber, ensureDefaultCategories } from "./expenses.service";
import { Adjustment, CompensationSegment, monthPeriod, netPay, salaryForMonth, stipendForMonth } from "./payrollMath";

/**
 * Payroll and stipend runs. The CFO only (decision D5).
 *
 *   DRAFT → REVIEW → APPROVED → PROCESSING (bank file prepared) → PAID
 *                                                     ↘ PARTIALLY_PAID
 *   A line that bounces is FAILED, with the reason, and can be paid later.
 *
 * Nothing here moves money. The bank file is prepared for an upload the CFO
 * does in the bank; each payment is then confirmed with its reference.
 *
 * Double payment is impossible by construction:
 *   salary   PayrollItem is unique per (employee, month);
 *   stipend  StipendPayout is unique per (intern, month) and is the same row
 *            the founder's workspace uses — a month paid there is skipped here,
 *            and a month in a live run is locked there.
 * Marking a line paid is idempotent per payment reference.
 *
 * Each payment also becomes an Expense (Salaries / Intern stipends) so pay
 * shows up in every total, budget and report.
 */

const ENTITY = "FinancePayroll";
const LIVE_RUN: PayrollRunStatus[] = ["DRAFT", "REVIEW", "APPROVED", "PROCESSING", "PARTIALLY_PAID", "PAID"];
const PAYABLE_RUN: PayrollRunStatus[] = ["APPROVED", "PROCESSING", "PARTIALLY_PAID"];
const monthLabel = (d: Date) => d.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

type Skipped = { name: string; reason: string };

/* Creating a run */

export async function createRun(a: FinanceAccess, input: { kind: PayrollKind; startupId: string; year: number; month: number; basis?: "FIXED" | "ATTENDANCE"; notes?: string | null }) {
  assertApprove(a);
  if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12 || !Number.isInteger(input.year) || input.year < 2020 || input.year > 2100) {
    throw new AppError(400, "Choose a month", "INVALID_PERIOD");
  }
  const startup = await prisma.startup.findUnique({ where: { id: input.startupId }, select: { id: true, name: true } });
  if (!startup) throw new AppError(404, "Not found", "NOT_FOUND");
  const { start, end } = monthPeriod(input.year, input.month);
  const basis = input.kind === "STIPEND" && input.basis === "ATTENDANCE" ? "ATTENDANCE" : "FIXED";

  return prisma.$transaction(async (tx) => {
    // One live run per kind, startup and month. The lock makes two clicks at once safe.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll:${input.kind}:${input.startupId}:${start.toISOString()}`}))`;
    const existing = await tx.payrollRun.findFirst({ where: { kind: input.kind, startupId: input.startupId, periodStart: start, status: { in: LIVE_RUN } }, select: { id: true } });
    if (existing) throw new AppError(409, `There is already a ${input.kind === "SALARY" ? "salary" : "stipend"} run for ${startup.name} for ${monthLabel(start)}`, "RUN_EXISTS");
    const run = await tx.payrollRun.create({
      data: { kind: input.kind, startupId: input.startupId, periodStart: start, periodEnd: end, basis, preparedBy: a.userId, notes: input.notes?.trim() || null },
    });
    const skipped = input.kind === "SALARY" ? await addSalaryLines(tx, run) : await addStipendLines(tx, run, input.year, input.month);
    await audit({ action: "finance.payroll.created", entity: ENTITY, entityId: run.id, actorId: a.userId, startupId: input.startupId, metadata: { kind: input.kind, period: start, basis, skipped } }, tx);
    return { id: run.id, skipped };
  });
}

type Tx = Prisma.TransactionClient;
type RunRow = { id: string; startupId: string; periodStart: Date; periodEnd: Date; basis: string };

async function addSalaryLines(tx: Tx, run: RunRow): Promise<Skipped[]> {
  const employees = await tx.employee.findMany({
    where: {
      startupId: run.startupId,
      joinedAt: { lte: run.periodEnd },
      OR: [{ status: { in: ["ACTIVE", "NOTICE"] } }, { exitedAt: { gte: run.periodStart } }],
    },
    include: {
      compensation: { where: { effectiveFrom: { lte: run.periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: run.periodStart } }] }, orderBy: { effectiveFrom: "asc" } },
      payrollItems: { where: { periodStart: run.periodStart }, select: { id: true } },
    },
  });
  const skipped: Skipped[] = [];
  for (const e of employees) {
    if (e.payrollItems.length) { skipped.push({ name: e.fullName, reason: "Already in another salary run for this month" }); continue; }
    if (!e.compensation.length) { skipped.push({ name: e.fullName, reason: "Pay not confirmed yet — confirm it in Salaries & stipends" }); continue; }
    const pay = salaryForMonth({
      periodStart: run.periodStart, periodEnd: run.periodEnd, joinedAt: e.joinedAt, exitedAt: e.exitedAt,
      segments: e.compensation.map((c): CompensationSegment => ({ id: c.id, effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo, monthlyGrossPaise: c.monthlyGrossPaise, components: (c.components as any[]) ?? [] })),
    });
    if (pay.workedDays === 0) { skipped.push({ name: e.fullName, reason: "No days worked in this month" }); continue; }
    await tx.payrollItem.create({
      data: {
        runId: run.id, employeeId: e.id, startupId: run.startupId, periodStart: run.periodStart, basePaise: pay.basePaise, workedDays: pay.workedDays,
        periodDays: pay.periodDays, components: pay.components as unknown as Prisma.InputJsonValue, netPaise: pay.basePaise, isFinalSettlement: pay.isFinalSettlement,
      },
    });
  }
  return skipped;
}

async function addStipendLines(tx: Tx, run: RunRow, year: number, month: number): Promise<Skipped[]> {
  const interns = await tx.intern.findMany({
    where: { startupId: run.startupId, startDate: { lte: run.periodEnd }, endDate: { gte: run.periodStart }, status: { not: "TERMINATED" } },
    include: { payouts: { where: { periodYear: year, periodMonth: month } } },
  });
  const skipped: Skipped[] = [];
  for (const i of interns) {
    const reason = await stipendLine(tx, run, i, year, month);
    if (reason) skipped.push({ name: i.fullName, reason });
  }
  return skipped;
}

/** Add or attach one intern's payout for the month. Returns why it was skipped, or null. */
async function stipendLine(tx: Tx, run: RunRow, i: Prisma.InternGetPayload<{ include: { payouts: true } }>, year: number, month: number) {
  const existing = i.payouts[0];
  if (existing?.status === "PAID") return "Already paid for this month";
  if (existing?.payrollRunId) {
    const other = await tx.payrollRun.findUnique({ where: { id: existing.payrollRunId }, select: { status: true } });
    if (other && other.status !== "CANCELLED") return "Already in another stipend run for this month";
  }
  if (i.stipendAmount == null) return "Stipend not confirmed yet — confirm it in Salaries & stipends";
  const figures = run.basis === "ATTENDANCE" ? await fromAttendance(run.startupId, i.id, year, month) : fromFixed(run, i);
  if (typeof figures === "string") return figures;
  const data = {
    startupId: run.startupId, internId: i.id, periodYear: year, periodMonth: month, stipendAmount: i.stipendAmount, ...figures,
    adjustment: 0, adjustmentNote: null, netAmount: figures.grossAmount, status: "DRAFT", payrollRunId: run.id, approvedBy: null, approvedAt: null,
  };
  if (existing) await tx.stipendPayout.update({ where: { id: existing.id }, data });
  else await tx.stipendPayout.create({ data });
  return null;
}

function fromFixed(run: RunRow, i: { startDate: Date; endDate: Date; stipendAmount: number | null }) {
  const s = stipendForMonth({ periodStart: run.periodStart, periodEnd: run.periodEnd, startDate: i.startDate, endDate: i.endDate, monthlyRupees: i.stipendAmount! });
  if (!s.activeDays) return "Not on the internship during this month";
  return { workingDays: s.periodDays, presentDays: s.activeDays, lateDays: 0, halfDays: 0, absentDays: 0, leaveDays: 0, paidLeaveDays: 0, payableCentidays: s.activeDays * 100, grossAmount: s.grossRupees };
}

async function fromAttendance(startupId: string, internId: string, year: number, month: number) {
  const c = await computeFor({ startupId, internId, year, month });
  if (c.problem) return c.problem;
  return { workingDays: c.workingDays, presentDays: c.presentDays, lateDays: c.lateDays, halfDays: c.halfDays, absentDays: c.absentDays, leaveDays: c.leaveDays, paidLeaveDays: c.paidLeaveDays, payableCentidays: c.payableCentidays, grossAmount: c.grossAmount };
}

/* Reading */

const lineInclude = {
  items: { include: { employee: { select: { id: true, fullName: true, employeeCode: true, designation: true, department: true, bankAccounts: { where: { deactivatedAt: null }, select: { accountLast4: true } } } } }, orderBy: { createdAt: "asc" as const } },
  stipends: { include: { intern: { select: { id: true, fullName: true, internCode: true, college: true, bankAccounts: { where: { deactivatedAt: null }, select: { accountLast4: true } } } } }, orderBy: { createdAt: "asc" as const } },
  startup: { select: { id: true, name: true, code: true } },
} satisfies Prisma.PayrollRunInclude;
type RunDetail = Prisma.PayrollRunGetPayload<{ include: typeof lineInclude }>;

/** Salary items and stipend payouts as one list of lines, in paise. */
function lines(run: RunDetail) {
  const salary = run.items.map((i) => ({
    id: i.id, type: "SALARY" as const, personId: i.employeeId, name: i.employee.fullName, code: i.employee.employeeCode, detail: i.employee.designation,
    workedDays: i.workedDays, periodDays: i.periodDays, basePaise: i.basePaise, adjustments: (i.adjustments as Adjustment[]) ?? [], netPaise: i.netPaise,
    status: i.status as string, paidOn: i.paidOn, paymentRef: i.paymentRef, failureReason: i.failureReason, bankLast4: i.employee.bankAccounts[0]?.accountLast4 ?? null,
    components: i.components, isFinalSettlement: i.isFinalSettlement, note: i.note,
  }));
  const stipend = run.stipends.map((p) => ({
    id: p.id, type: "STIPEND" as const, personId: p.internId, name: p.intern.fullName, code: p.intern.internCode, detail: p.intern.college,
    workedDays: Math.round(p.payableCentidays / 100), periodDays: p.workingDays, basePaise: p.grossAmount * 100,
    adjustments: p.adjustment ? [{ kind: p.adjustment < 0 ? "DEDUCTION" : "INCENTIVE", label: p.adjustmentNote ?? "Adjustment", amountPaise: Math.abs(p.adjustment) * 100 }] : [],
    netPaise: p.netAmount * 100, status: payoutStatus(p.status), paidOn: p.paidAt, paymentRef: p.paymentRef, failureReason: p.failureReason,
    bankLast4: p.intern.bankAccounts[0]?.accountLast4 ?? null, components: null, isFinalSettlement: false, note: p.adjustmentNote,
  }));
  return [...salary, ...stipend];
}
const payoutStatus = (s: string) => (s === "PAID" ? "PAID" : s === "FAILED" ? "FAILED" : s === "ON_HOLD" ? "ON_HOLD" : "PENDING");

function summarise(run: RunDetail) {
  const ls = lines(run);
  const payable = ls.filter((l) => l.status !== "ON_HOLD");
  return {
    lines: ls,
    totals: {
      people: ls.length,
      netPaise: payable.reduce((s, l) => s + l.netPaise, 0),
      paidPaise: ls.filter((l) => l.status === "PAID").reduce((s, l) => s + l.netPaise, 0),
      unpaidPaise: payable.filter((l) => l.status !== "PAID").reduce((s, l) => s + l.netPaise, 0),
      failed: ls.filter((l) => l.status === "FAILED").length,
      onHold: ls.filter((l) => l.status === "ON_HOLD").length,
      missingBank: payable.filter((l) => !l.bankLast4 && l.status !== "PAID").length,
    },
  };
}

export async function listRuns(a: FinanceAccess, q: { startupId?: string; kind?: PayrollKind }) {
  assertApprove(a);
  const runs = await prisma.payrollRun.findMany({
    where: { ...(q.startupId ? { startupId: q.startupId } : {}), ...(q.kind ? { kind: q.kind } : {}) },
    include: lineInclude,
    orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  return runs.map((r) => ({ id: r.id, kind: r.kind, startup: r.startup, periodStart: r.periodStart, status: r.status, basis: r.basis, approvedAt: r.approvedAt, ...summarise(r).totals }));
}

export async function getRun(a: FinanceAccess, id: string) {
  assertApprove(a);
  const run = await prisma.payrollRun.findUnique({ where: { id }, include: lineInclude });
  if (!run) throw new AppError(404, "Not found", "NOT_FOUND");
  const history = await prisma.auditLog.findMany({ where: { entity: ENTITY, entityId: id }, orderBy: { createdAt: "asc" } });
  const { startup, items: _i, stipends: _s, ...rest } = run;
  return { ...rest, startup, ...summarise(run), history: history.map((h) => ({ at: h.createdAt, action: h.action, by: h.adminId, details: h.metadata })) };
}

async function loadRun(id: string) {
  const run = await prisma.payrollRun.findUnique({ where: { id } });
  if (!run) throw new AppError(404, "Not found", "NOT_FOUND");
  return run;
}

/* Editing lines (draft or review only) */

export type LineChange = { adjustments?: Adjustment[]; hold?: boolean; note?: string | null };

function cleanAdjustments(list: Adjustment[]) {
  const kinds = ["INCENTIVE", "BONUS", "DEDUCTION", "REIMBURSEMENT", "SETTLEMENT"];
  if (list.length > 20) throw new AppError(400, "Up to 20 adjustments", "TOO_MANY");
  return list.map((x) => {
    if (!kinds.includes(x.kind)) throw new AppError(400, "Unknown adjustment type", "INVALID_ADJUSTMENT");
    const label = String(x.label ?? "").trim();
    if (label.length < 2) throw new AppError(400, "Say what each adjustment is for", "LABEL_REQUIRED");
    return { kind: x.kind, label: label.slice(0, 80), amountPaise: rupeesToPaise((x as any).amount ?? x.amountPaise / 100) };
  });
}

export async function changeLine(a: FinanceAccess, runId: string, lineId: string, change: LineChange) {
  assertApprove(a);
  const run = await loadRun(runId);
  if (!["DRAFT", "REVIEW"].includes(run.status)) throw new AppError(409, "Lines can be changed only before the run is approved", "WRONG_STATUS");
  const result = run.kind === "SALARY" ? await changeSalaryLine(runId, lineId, change) : await changeStipendLine(runId, lineId, change);
  await audit({ action: "finance.payroll.line_changed", entity: ENTITY, entityId: runId, actorId: a.userId, startupId: run.startupId, metadata: { lineId, ...result } });
  return getRun(a, runId);
}

async function changeSalaryLine(runId: string, lineId: string, change: LineChange) {
  const item = await prisma.payrollItem.findFirst({ where: { id: lineId, runId } });
  if (!item) throw new AppError(404, "Not found", "NOT_FOUND");
  const adjustments = change.adjustments ? cleanAdjustments(change.adjustments) : (item.adjustments as Adjustment[]);
  const net = netPay(item.basePaise, adjustments as Adjustment[]);
  if (net < 0) throw new AppError(400, "Deductions can't make the pay negative", "NEGATIVE_PAY");
  await prisma.payrollItem.update({
    where: { id: lineId },
    data: { adjustments: adjustments as unknown as Prisma.InputJsonValue, netPaise: net, ...(change.hold !== undefined ? { status: change.hold ? "ON_HOLD" : "PENDING" } : {}), ...(change.note !== undefined ? { note: change.note?.trim() || null } : {}) },
  });
  return { from: item.netPaise, to: net, hold: change.hold ?? null };
}

async function changeStipendLine(runId: string, lineId: string, change: LineChange) {
  const p = await prisma.stipendPayout.findFirst({ where: { id: lineId, payrollRunId: runId } });
  if (!p) throw new AppError(404, "Not found", "NOT_FOUND");
  // Stipends hold one adjustment in whole rupees (the workspace's model): the sum of the lines given.
  const adjustments = change.adjustments ? cleanAdjustments(change.adjustments) : null;
  const adjustmentPaise = adjustments ? netPay(0, adjustments as Adjustment[]) : p.adjustment * 100;
  if (adjustmentPaise % 100 !== 0) throw new AppError(400, "Stipend adjustments are whole rupees", "WHOLE_RUPEES");
  const net = p.grossAmount + adjustmentPaise / 100;
  if (net < 0) throw new AppError(400, "Deductions can't make the stipend negative", "NEGATIVE_PAY");
  await prisma.stipendPayout.update({
    where: { id: lineId },
    data: {
      adjustment: adjustmentPaise / 100, netAmount: net,
      ...(adjustments ? { adjustmentNote: adjustments.map((x) => x.label).join("; ") || null } : {}),
      ...(change.hold !== undefined ? { status: change.hold ? "ON_HOLD" : "DRAFT" } : {}),
    },
  });
  return { from: p.netAmount * 100, to: net * 100, hold: change.hold ?? null };
}

/* Moving the run along */

type Transition = { from: PayrollRunStatus[]; to: PayrollRunStatus; action: string; data?: Prisma.PayrollRunUncheckedUpdateInput; metadata?: Record<string, unknown> };

async function setStatus(a: FinanceAccess, id: string, t: Transition) {
  const { from, to, action, data = {}, metadata = {} } = t;
  assertApprove(a);
  const run = await loadRun(id);
  if (!from.includes(run.status)) throw new AppError(409, `This run is ${run.status.toLowerCase().replace("_", " ")}`, "WRONG_STATUS");
  await prisma.$transaction(async (tx) => {
    const n = await tx.payrollRun.updateMany({ where: { id, status: run.status }, data: { ...data, status: to } });
    if (n.count !== 1) throw new AppError(409, "Someone else just changed this run. Reload and try again.", "CONFLICT");
    if (run.kind === "STIPEND" && to === "APPROVED") {
      await tx.stipendPayout.updateMany({ where: { payrollRunId: id, status: "DRAFT" }, data: { status: "APPROVED", approvedBy: a.userId, approvedAt: new Date() } });
    }
    if (run.kind === "STIPEND" && to === "DRAFT") {
      await tx.stipendPayout.updateMany({ where: { payrollRunId: id, status: "APPROVED" }, data: { status: "DRAFT", approvedBy: null, approvedAt: null } });
    }
    await audit({ action: `finance.payroll.${action}`, entity: ENTITY, entityId: id, actorId: a.userId, startupId: run.startupId, metadata: { from: run.status, to, ...metadata } }, tx);
  });
  return getRun(a, id);
}

export const submitForReview = (a: FinanceAccess, id: string) => setStatus(a, id, { from: ["DRAFT"], to: "REVIEW", action: "submitted" });
export const backToDraft = (a: FinanceAccess, id: string) => setStatus(a, id, { from: ["REVIEW", "APPROVED"], to: "DRAFT", action: "reopened" });

export function approveRun(a: FinanceAccess, id: string, confirm: boolean) {
  if (!confirm) throw new AppError(400, "Confirm you've checked every line before approving", "CONFIRM_REQUIRED");
  return setStatus(a, id, { from: ["REVIEW"], to: "APPROVED", action: "approved", data: { approvedBy: a.userId, approvedAt: new Date() } });
}

export async function cancelRun(a: FinanceAccess, id: string, reason: string) {
  assertApprove(a);
  if (!reason?.trim()) throw new AppError(400, "Say why the run is cancelled", "REASON_REQUIRED");
  const run = await loadRun(id);
  const paid = (await prisma.payrollItem.count({ where: { runId: id, status: "PAID" } })) + (await prisma.stipendPayout.count({ where: { payrollRunId: id, status: "PAID" } }));
  if (paid) throw new AppError(409, "Some lines are already paid — a run with payments can't be cancelled", "HAS_PAYMENTS");
  if (!["DRAFT", "REVIEW", "APPROVED", "PROCESSING"].includes(run.status)) throw new AppError(409, "This run can't be cancelled", "WRONG_STATUS");
  await prisma.$transaction(async (tx) => {
    // Unpaid lines go: the month can then be prepared again.
    await tx.payrollItem.deleteMany({ where: { runId: id } });
    await tx.stipendPayout.deleteMany({ where: { payrollRunId: id, status: { not: "PAID" } } });
    await tx.payrollRun.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.trim() } });
    await audit({ action: "finance.payroll.cancelled", entity: ENTITY, entityId: id, actorId: a.userId, startupId: run.startupId, metadata: { reason } }, tx);
  });
  return getRun(a, id);
}

/* The bank file */

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * A CSV for the bank's bulk-transfer upload: one row per unpaid, not-on-hold
 * line with bank details. Account numbers are decrypted only into this file —
 * never stored in plain text and never written to the audit log.
 */
export async function bankFile(a: FinanceAccess, id: string) {
  assertApprove(a);
  const run = await loadRun(id);
  if (!PAYABLE_RUN.includes(run.status)) throw new AppError(409, "Approve the run before preparing the bank file", "NOT_APPROVED");
  const detail = await prisma.payrollRun.findUnique({ where: { id }, include: lineInclude });
  const ls = lines(detail!).filter((l) => l.status !== "PAID" && l.status !== "ON_HOLD" && l.netPaise > 0);
  const accounts = await prisma.payeeBankAccount.findMany({
    where: { deactivatedAt: null, OR: [{ employeeId: { in: ls.filter((l) => l.type === "SALARY").map((l) => l.personId) } }, { internId: { in: ls.filter((l) => l.type === "STIPEND").map((l) => l.personId) } }] },
  });
  const byPerson = new Map(accounts.map((x) => [x.employeeId ?? x.internId!, x]));
  const what = `${run.kind === "SALARY" ? "Salary" : "Stipend"} ${monthLabel(run.periodStart)}`;
  const rows = [["Beneficiary name", "Account number", "IFSC", "Amount (INR)", "Narration", "Reference"]];
  const missing: string[] = [];
  let total = 0;
  for (const l of ls) {
    const acct = byPerson.get(l.personId);
    const number = acct ? unseal({ cipher: acct.accountCipher, iv: acct.accountIv, tag: acct.accountTag }) : null;
    if (!acct || !number) { missing.push(l.name); continue; }
    rows.push([acct.accountHolder, number, acct.ifsc, (l.netPaise / 100).toFixed(2), `${what} ${l.code}`.slice(0, 30), l.id]);
    total += l.netPaise;
  }
  await prisma.$transaction(async (tx) => {
    if (run.status === "APPROVED") await tx.payrollRun.update({ where: { id }, data: { status: "PROCESSING", exportedAt: new Date(), exportedBy: a.userId } });
    await audit({ action: "finance.payroll.bank_file", entity: ENTITY, entityId: id, actorId: a.userId, startupId: run.startupId, metadata: { rows: rows.length - 1, totalPaise: total, missing } }, tx);
  });
  return {
    filename: `${what.replace(/\s+/g, "-").toLowerCase()}-${id.slice(0, 8)}.csv`,
    csv: rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n",
    included: rows.length - 1,
    totalPaise: total,
    missing,
  };
}

/* Confirming payments */

export async function markLinePaid(a: FinanceAccess, runId: string, lineId: string, input: { paidOn: string; paymentRef?: string | null; paymentMethod?: PaymentMethod | null }) {
  assertApprove(a);
  const run = await loadRun(runId);
  if (!PAYABLE_RUN.includes(run.status)) throw new AppError(409, "Approve the run before recording payments", "NOT_APPROVED");
  const paidOn = parseDate(input.paidOn, "payment date");
  const ref = input.paymentRef?.trim() || null;
  const line = lines((await prisma.payrollRun.findUnique({ where: { id: runId }, include: lineInclude }))!).find((l) => l.id === lineId);
  if (!line) throw new AppError(404, "Not found", "NOT_FOUND");
  if (line.status === "PAID") {
    if ((line.paymentRef ?? null) === ref) return getRun(a, runId);
    throw new AppError(409, `Already paid${line.paymentRef ? ` (reference ${line.paymentRef})` : ""}`, "ALREADY_PAID");
  }
  if (line.status === "ON_HOLD") throw new AppError(409, "This line is on hold", "ON_HOLD");
  await ensureDefaultCategories();
  const category = await prisma.financeCategory.findUnique({ where: { key: run.kind === "SALARY" ? "salaries" : "stipends" } });

  await prisma.$transaction(async (tx) => {
    const expenseId = line.netPaise > 0 ? await payExpense(tx, { a, run, line, categoryId: category!.id, paidOn, ref, method: input.paymentMethod ?? "BANK_TRANSFER" }) : null;
    const done = run.kind === "SALARY"
      ? await tx.payrollItem.updateMany({ where: { id: lineId, status: { in: ["PENDING", "FAILED"] } }, data: { status: "PAID", paidOn, paymentRef: ref, paymentMethod: input.paymentMethod ?? "BANK_TRANSFER", failureReason: null, expenseId } })
      : await tx.stipendPayout.updateMany({ where: { id: lineId, status: { in: ["DRAFT", "APPROVED", "FAILED"] } }, data: { status: "PAID", paidAt: paidOn, paymentRef: ref, paymentMethod: input.paymentMethod ?? "BANK_TRANSFER", failureReason: null, expenseId } });
    if (done.count !== 1) throw new AppError(409, "This line was just changed. Reload and try again.", "CONFLICT");
    await audit({ action: "finance.payroll.line_paid", entity: ENTITY, entityId: runId, actorId: a.userId, startupId: run.startupId, metadata: { lineId, name: line.name, netPaise: line.netPaise, paymentRef: ref, expenseId } }, tx);
  });
  await settleRunStatus(runId);
  return getRun(a, runId);
}

/** The expense for one payment, already paid: Salaries or Intern stipends, owned by the startup. */
type PaymentRecord = {
  a: FinanceAccess; run: { id: string; kind: PayrollKind; startupId: string; periodStart: Date }; line: { id: string; name: string; code: string; netPaise: number };
  categoryId: string; paidOn: Date; ref: string | null; method: PaymentMethod;
};

async function payExpense(tx: Tx, p: PaymentRecord) {
  const { a, run, line, categoryId, paidOn, ref, method } = p;
  const number = await nextExpenseNumber(tx, run.startupId, paidOn);
  const e = await tx.expense.create({
    data: {
      number, startupId: run.startupId, kind: "VENDOR_BILL", title: `${run.kind === "SALARY" ? "Salary" : "Stipend"} — ${line.name} (${line.code}) — ${monthLabel(run.periodStart)}`,
      categoryId, payee: line.name, amountPaise: line.netPaise, incurredOn: paidOn, status: "PAID", paymentMethod: method,
      submittedBy: a.userId, submittedAt: new Date(), approvedBy: a.userId, approvedAt: new Date(), paidBy: a.userId, paidAt: paidOn, paymentRef: ref,
      source: run.kind === "SALARY" ? "PAYROLL" : "STIPEND_RUN", sourceId: line.id,
    },
  });
  await audit({ action: "finance.expense.created", entity: "FinanceExpense", entityId: e.id, actorId: a.userId, startupId: run.startupId, metadata: { number, status: "PAID", amountPaise: e.amountPaise, source: e.source, sourceId: line.id, runId: run.id } }, tx);
  return e.id;
}

export async function markLineFailed(a: FinanceAccess, runId: string, lineId: string, reason: string) {
  assertApprove(a);
  if (!reason?.trim()) throw new AppError(400, "Say why the payment failed", "REASON_REQUIRED");
  const run = await loadRun(runId);
  if (!PAYABLE_RUN.includes(run.status)) throw new AppError(409, "Only payments in an approved run can fail", "NOT_APPROVED");
  const n = run.kind === "SALARY"
    ? await prisma.payrollItem.updateMany({ where: { id: lineId, runId, status: { in: ["PENDING", "FAILED"] } }, data: { status: "FAILED", failureReason: reason.trim() } })
    : await prisma.stipendPayout.updateMany({ where: { id: lineId, payrollRunId: runId, status: { in: ["APPROVED", "FAILED"] } }, data: { status: "FAILED", failureReason: reason.trim() } });
  if (n.count !== 1) throw new AppError(409, "Only an unpaid line can be marked failed", "WRONG_STATUS");
  await audit({ action: "finance.payroll.line_failed", entity: ENTITY, entityId: runId, actorId: a.userId, startupId: run.startupId, metadata: { lineId, reason } });
  await settleRunStatus(runId);
  return getRun(a, runId);
}

/** PAID when every line not on hold is paid; PARTIALLY_PAID when some are. */
async function settleRunStatus(id: string) {
  const run = await prisma.payrollRun.findUnique({ where: { id }, include: lineInclude });
  if (!run || !PAYABLE_RUN.includes(run.status)) return;
  const payable = lines(run).filter((l) => l.status !== "ON_HOLD");
  const paid = payable.filter((l) => l.status === "PAID").length;
  const next: PayrollRunStatus = paid === 0 ? run.status : paid === payable.length ? "PAID" : "PARTIALLY_PAID";
  if (next !== run.status) await prisma.payrollRun.update({ where: { id }, data: { status: next, ...(next === "PAID" ? { paidAt: new Date() } : {}) } });
}

/* Reports */

export async function runReportCsv(a: FinanceAccess, id: string) {
  const run = await getRun(a, id);
  const rows = [["Name", "Code", "Role / college", "Days", "Base (INR)", "Adjustments (INR)", "Net (INR)", "Status", "Paid on", "Reference"]];
  for (const l of run.lines) {
    const adj = l.netPaise - l.basePaise;
    rows.push([l.name, l.code, l.detail ?? "", `${l.workedDays}/${l.periodDays}`, (l.basePaise / 100).toFixed(2), (adj / 100).toFixed(2), (l.netPaise / 100).toFixed(2), l.status, l.paidOn ? new Date(l.paidOn).toISOString().slice(0, 10) : "", l.paymentRef ?? ""]);
  }
  rows.push(["Total", "", "", "", "", "", (run.totals.netPaise / 100).toFixed(2), "", "", ""]);
  return { filename: `${run.kind.toLowerCase()}-${run.startup.code ?? "startup"}-${new Date(run.periodStart).toISOString().slice(0, 7)}.csv`, csv: rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n" };
}

/** Unpaid pay in approved runs — the dashboard's "pay due". */
export async function payDue(startupId: string | null) {
  const runs = await prisma.payrollRun.findMany({ where: { status: { in: PAYABLE_RUN }, ...(startupId ? { startupId } : {}) }, include: lineInclude });
  return runs.reduce((s, r) => s + summarise(r).totals.unpaidPaise, 0);
}
