import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { htmlToPdf } from "../../lib/pdf";
import { esc } from "../../lib/email/layout";
import { audit } from "../shared/audit.service";
import { FinanceAccess, canSeePay, canView, scopeWhere } from "./access";
import { PeriodKind, periodRange } from "./money";
import { listBudgets } from "./budgets.service";
import { listSubscriptions } from "./subscriptions.service";
import { listInvoices } from "./invoices.service";
import { revenue } from "./revenue.service";
import { headcounts } from "./expenses.service";

/**
 * Finance reports, as CSV, Excel or PDF, each with a plain-language note on
 * what the figures mean and what they leave out.
 *
 * Every report respects the reader's scope (a startup's people see only that
 * startup); the payroll report is the CFO's only. Every export is recorded in
 * the audit log — who took which report, for what scope and period.
 *
 * Nothing here calls anyone profitable. "Money in minus money out" is shown
 * as exactly that, on a cash basis, with internal transfers left out.
 */

export type ReportKind = "summary" | "expenses" | "income" | "payroll" | "budgets" | "subscriptions" | "receivables" | "startups";
export type ReportFormat = "csv" | "xlsx" | "pdf";
type Col = { key: string; label: string; type?: "text" | "money" | "date" | "number" };
type Report = { title: string; notes: string[]; columns: Col[]; rows: Array<Record<string, unknown>>; totals?: Record<string, unknown> };
type Query = { scope?: string; period?: PeriodKind; anchor?: string; from?: string; to?: string; categoryId?: string; status?: string };

const rupees = (p: number) => Math.round(p) / 100;
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const LIVE = ["SUBMITTED", "NEEDS_INFO", "APPROVED", "PAID"] as const;

function range(q: Query) {
  return periodRange(q.period ?? "month", q.anchor ? new Date(`${q.anchor}T00:00:00Z`) : new Date(), { from: q.from, to: q.to });
}

/* Builders */

async function expensesReport(a: FinanceAccess, q: Query, from: Date, to: Date): Promise<Report> {
  const where: Prisma.ExpenseWhereInput = {
    deletedAt: null, ...scopeWhere(a, q.scope), incurredOn: { gte: from, lte: to },
    ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.status ? { status: q.status as any } : { status: { in: [...LIVE] } }),
  };
  const rows = await prisma.expense.findMany({ where, include: { category: true, vendor: true, startup: true }, orderBy: { incurredOn: "asc" }, take: 10000 });
  return {
    title: "Expenses",
    notes: ["Every expense dated in the period (drafts, rejected and cancelled ones left out unless you filtered for them).", "A shared central cost appears once, under Central DevUp, however it was split between startups.", "Corrections are their own rows, linked to what they correct."],
    columns: [
      { key: "number", label: "Number" }, { key: "date", label: "Date", type: "date" }, { key: "owner", label: "Whose cost" }, { key: "title", label: "What" },
      { key: "category", label: "Category" }, { key: "group", label: "Group" }, { key: "paidTo", label: "Paid to" }, { key: "status", label: "Status" },
      { key: "amount", label: "Amount (₹)", type: "money" }, { key: "paymentRef", label: "Payment reference" },
    ],
    rows: rows.map((e) => ({
      number: e.number, date: day(e.incurredOn), owner: e.startup?.name ?? "Central DevUp", title: e.title, category: e.category.name, group: e.category.group,
      paidTo: e.vendor?.name ?? e.payee ?? "", status: e.status, amount: rupees(e.amountPaise), paymentRef: e.paymentRef ?? "",
    })),
    totals: { number: "Total", amount: rupees(rows.reduce((s, e) => s + e.amountPaise, 0)) },
  };
}

async function incomeReport(a: FinanceAccess, q: Query, from: Date, to: Date): Promise<Report> {
  const r = await revenue(a, { scope: q.scope, from, to });
  const rows = [
    ...r.entries.map((e) => ({ date: day(e.receivedOn), receivedBy: e.startup?.name ?? "Central DevUp", kind: e.source, what: e.title, payer: e.payer, reference: e.reference ?? "", amount: rupees(e.amountPaise) })),
    ...r.b2b.payments.map((p) => ({ date: day(p.paidOn), receivedBy: "Central DevUp", kind: "B2B_CLIENT_WORK", what: p.engagement.title, payer: p.engagement.clientCompany, reference: p.reference ?? "", amount: rupees(p.amountPaise) })),
  ].sort((x, y) => x.date.localeCompare(y.date));
  return {
    title: "Money received",
    notes: ["Money that arrived from outside DevUp in the period (cash basis): counted when received, not when invoiced.", `B2B work invoiced but not yet paid: ₹${rupees(r.b2b.invoicedNotReceivedPaise).toLocaleString("en-IN")} — not income until paid.`, "Payments startups make on DevUp's internal bills are not income and are not included."],
    columns: [{ key: "date", label: "Received on", type: "date" }, { key: "receivedBy", label: "Received by" }, { key: "kind", label: "Kind" }, { key: "what", label: "What for" }, { key: "payer", label: "Paid by" }, { key: "reference", label: "Reference" }, { key: "amount", label: "Amount (₹)", type: "money" }],
    rows,
    totals: { date: "Total", amount: rupees(r.receivedPaise) },
  };
}

async function payrollReport(a: FinanceAccess, q: Query, from: Date, to: Date): Promise<Report> {
  if (!canSeePay(a)) throw new AppError(403, "Only the CFO can export payroll", "CFO_ONLY");
  const startup = q.scope && q.scope !== "all" && q.scope !== "central" ? q.scope : undefined;
  const runs = await prisma.payrollRun.findMany({
    where: { status: { not: "CANCELLED" }, periodStart: { gte: from, lte: to }, ...(startup ? { startupId: startup } : {}) },
    include: { startup: true, items: { include: { employee: true } }, stipends: { include: { intern: true } } },
    orderBy: { periodStart: "asc" },
  });
  const rows = runs.flatMap((r) => [
    ...r.items.map((i) => ({ month: day(r.periodStart).slice(0, 7), startup: r.startup.name, kind: "Salary", person: i.employee.fullName, code: i.employee.employeeCode, days: `${i.workedDays}/${i.periodDays}`, base: rupees(i.basePaise), net: rupees(i.netPaise), status: i.status, paidOn: day(i.paidOn), runStatus: r.status })),
    ...r.stipends.map((p) => ({ month: day(r.periodStart).slice(0, 7), startup: r.startup.name, kind: "Stipend", person: p.intern.fullName, code: p.intern.internCode, days: `${Math.round(p.payableCentidays / 100)}/${p.workingDays}`, base: p.grossAmount, net: p.netAmount, status: p.status, paidOn: day(p.paidAt), runStatus: r.status })),
  ]);
  return {
    title: "Payroll",
    notes: ["Salaries and stipends in payroll runs for months in the period (cancelled runs left out).", "Net = base for the days worked, plus bonuses and reimbursements, minus deductions. No statutory deductions (PF, ESI, TDS, professional tax) are calculated."],
    columns: [{ key: "month", label: "Month" }, { key: "startup", label: "Startup" }, { key: "kind", label: "Kind" }, { key: "person", label: "Person" }, { key: "code", label: "Code" }, { key: "days", label: "Days" }, { key: "base", label: "Base (₹)", type: "money" }, { key: "net", label: "Net (₹)", type: "money" }, { key: "status", label: "Status" }, { key: "paidOn", label: "Paid on", type: "date" }, { key: "runStatus", label: "Run" }],
    rows,
    totals: { month: "Total", net: rows.reduce((s, r) => s + Number(r.net), 0) },
  };
}

async function budgetsReport(a: FinanceAccess, q: Query): Promise<Report> {
  const list = await listBudgets(a, { scope: q.scope });
  return {
    title: "Budget use",
    notes: ["Left = budget − spent (paid) − committed (approved, not paid yet). Nothing is counted twice.", "A startup's budget includes its share of shared DevUp costs."],
    columns: [{ key: "budget", label: "Budget" }, { key: "for", label: "For" }, { key: "from", label: "From", type: "date" }, { key: "to", label: "To", type: "date" }, { key: "line", label: "Line" }, { key: "allocated", label: "Budget (₹)", type: "money" }, { key: "spent", label: "Spent (₹)", type: "money" }, { key: "committed", label: "Committed (₹)", type: "money" }, { key: "left", label: "Left (₹)", type: "money" }, { key: "used", label: "Used %", type: "number" }],
    rows: list.flatMap((b) => b.lines.map((l) => ({ budget: b.name, for: b.startup?.name ?? (b.scope === "CENTRAL" ? "Central DevUp" : "All of DevUp"), from: day(b.periodStart), to: day(b.periodEnd), line: l.categoryGroup ?? "All spending", allocated: rupees(l.allocatedPaise), spent: rupees(l.spentPaise), committed: rupees(l.committedPaise), left: rupees(l.availablePaise), used: l.usedPercent }))),
  };
}

async function subscriptionsReport(a: FinanceAccess, q: Query): Promise<Report> {
  const d = await listSubscriptions(a, q.scope);
  return {
    title: "Subscriptions",
    notes: ["Monthly cost averages yearly and quarterly plans out over months.", "Seats count as used only when someone is assigned to them."],
    columns: [{ key: "name", label: "Subscription" }, { key: "provider", label: "Provider" }, { key: "plan", label: "Plan" }, { key: "for", label: "For" }, { key: "status", label: "Status" }, { key: "monthly", label: "Per month (₹)", type: "money" }, { key: "seats", label: "Seats used" }, { key: "renewal", label: "Renews", type: "date" }],
    rows: d.subscriptions.map((s) => ({ name: s.name, provider: s.provider, plan: s.plan ?? "", for: s.startup?.name ?? "Central DevUp", status: s.status, monthly: rupees(s.monthlyPaise), seats: s.seatsPurchased != null ? `${s.seatsAssigned}/${s.seatsPurchased}` : String(s.seatsAssigned), renewal: day(s.renewalOn) })),
    totals: { name: "Active, per month", monthly: rupees(d.totals.monthlyPaise) },
  };
}

async function receivablesReport(a: FinanceAccess, q: Query): Promise<Report> {
  const d = await listInvoices(a, { scope: q.scope });
  return {
    title: "Money expected from startups",
    notes: ["Bills from central DevUp to its startups, and what's still owed. Internal: these never count as DevUp income."],
    columns: [{ key: "number", label: "Bill" }, { key: "startup", label: "Startup" }, { key: "title", label: "For" }, { key: "issued", label: "Issued", type: "date" }, { key: "due", label: "Due", type: "date" }, { key: "status", label: "Status" }, { key: "amount", label: "Amount (₹)", type: "money" }, { key: "paid", label: "Paid (₹)", type: "money" }, { key: "owed", label: "Still owed (₹)", type: "money" }, { key: "overdue", label: "Overdue" }],
    rows: d.invoices.map((i) => ({ number: i.number, startup: i.recipient.name, title: i.title, issued: day(i.issueDate), due: day(i.dueDate), status: i.flag ? `${i.status} (${i.flag})` : i.status, amount: rupees(i.amountPaise), paid: rupees(i.receivedPaise), owed: rupees(i.outstandingPaise), overdue: i.isOverdue ? "Yes" : "" })),
    totals: { number: "Total", owed: rupees(d.totals.outstandingPaise) },
  };
}

async function startupsReport(a: FinanceAccess, from: Date, to: Date): Promise<Report> {
  const startups = await prisma.startup.findMany({ where: a.viewAll ? {} : { id: { in: [...a.viewStartups] } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const ids = startups.map((s) => s.id);
  const inPeriod = { gte: from, lte: to };
  const [own, shares, income, owed, hc] = await Promise.all([
    prisma.expense.groupBy({ by: ["startupId"], where: { deletedAt: null, status: "PAID", incurredOn: inPeriod, startupId: { in: ids } }, _sum: { amountPaise: true } }),
    prisma.expenseAllocation.groupBy({ by: ["startupId"], where: { startupId: { in: ids }, expense: { deletedAt: null, startupId: null, status: "PAID", incurredOn: inPeriod } }, _sum: { amountPaise: true } }),
    prisma.incomeEntry.groupBy({ by: ["startupId"], where: { voidedAt: null, receivedOn: inPeriod, startupId: { in: ids } }, _sum: { amountPaise: true } }),
    prisma.financeInvoice.findMany({ where: { status: { in: ["ISSUED", "PART_PAID"] }, recipientStartupId: { in: ids } }, select: { recipientStartupId: true, amountPaise: true, receivedPaise: true } }),
    headcounts(ids),
  ]);
  const m = (list: Array<{ startupId: string | null; _sum: { amountPaise: number | null } }>) => new Map(list.map((x) => [x.startupId, x._sum.amountPaise ?? 0]));
  const [o, s, inc] = [m(own), m(shares), m(income)];
  const owedBy = new Map<string, number>();
  for (const i of owed) owedBy.set(i.recipientStartupId, (owedBy.get(i.recipientStartupId) ?? 0) + i.amountPaise - i.receivedPaise);
  return {
    title: "Startups at a glance",
    notes: ["Own spending: paid expenses the startup carries itself. Share of shared costs: its part of central DevUp bills, shown separately and not counted again in DevUp's total.", "Money in: received from outside DevUp. Money in − own spending is a cash figure, not profit."],
    columns: [{ key: "startup", label: "Startup" }, { key: "people", label: "People now", type: "number" }, { key: "own", label: "Own spending (₹)", type: "money" }, { key: "share", label: "Share of shared costs (₹)", type: "money" }, { key: "income", label: "Money in (₹)", type: "money" }, { key: "cash", label: "Money in − own spending (₹)", type: "money" }, { key: "owed", label: "Owes DevUp (₹)", type: "money" }],
    rows: startups.map((st) => ({
      startup: st.name, people: hc.get(st.id) ?? 0, own: rupees(o.get(st.id) ?? 0), share: rupees(s.get(st.id) ?? 0), income: rupees(inc.get(st.id) ?? 0),
      cash: rupees((inc.get(st.id) ?? 0) - (o.get(st.id) ?? 0)), owed: rupees(owedBy.get(st.id) ?? 0),
    })),
  };
}

async function summaryReport(a: FinanceAccess, q: Query, from: Date, to: Date): Promise<Report> {
  const where = { deletedAt: null, ...scopeWhere(a, q.scope), incurredOn: { gte: from, lte: to } };
  const [paid, approved, groups, money, recv] = await Promise.all([
    prisma.expense.aggregate({ where: { ...where, status: "PAID" }, _sum: { amountPaise: true } }),
    prisma.expense.aggregate({ where: { ...where, status: "APPROVED" }, _sum: { amountPaise: true } }),
    prisma.expense.findMany({ where: { ...where, status: "PAID" }, select: { amountPaise: true, category: { select: { group: true } } } }),
    revenue(a, { scope: q.scope, from, to }),
    q.scope && q.scope !== "all" && q.scope !== "central" && !canView(a, q.scope) ? Promise.resolve(null) : listInvoices(a, { scope: q.scope }).then((d) => d.totals.outstandingPaise),
  ]);
  const by = new Map<string, number>();
  for (const g of groups) by.set(g.category.group, (by.get(g.category.group) ?? 0) + g.amountPaise);
  const spent = paid._sum.amountPaise ?? 0;
  const rows: Array<Record<string, unknown>> = [
    { item: "Money received (from outside DevUp)", amount: rupees(money.receivedPaise) },
    { item: "Spent (paid expenses)", amount: rupees(spent) },
    { item: "Money in − money out (cash, not profit)", amount: rupees(money.receivedPaise - spent) },
    { item: "Approved, still to pay", amount: rupees(approved._sum.amountPaise ?? 0) },
    { item: "Money expected from startups (internal)", amount: recv == null ? "" : rupees(recv) },
    ...[...by.entries()].sort((x, y) => y[1] - x[1]).map(([group, p]) => ({ item: `Spent on ${group}`, amount: rupees(p) })),
  ];
  return {
    title: "Summary",
    notes: ["Cash basis: money counts when it is paid or received.", "Each shared cost is counted once; payments between DevUp and its startups are internal and left out of money in and money out.", "\"Money in − money out\" is not profit: there is no accrual accounting behind it."],
    columns: [{ key: "item", label: "What" }, { key: "amount", label: "Amount (₹)", type: "money" }],
    rows,
  };
}

/* Rendering */

const BUILD: Record<ReportKind, (a: FinanceAccess, q: Query, from: Date, to: Date) => Promise<Report>> = {
  summary: summaryReport, expenses: expensesReport, income: incomeReport, payroll: payrollReport,
  budgets: (a, q) => budgetsReport(a, q), subscriptions: (a, q) => subscriptionsReport(a, q), receivables: (a, q) => receivablesReport(a, q),
  startups: (a, _q, from, to) => startupsReport(a, from, to),
};

const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function toCsv(r: Report, heading: string) {
  const lines = [[heading], ...r.notes.map((n) => [`Note: ${n}`]), [], r.columns.map((c) => c.label), ...r.rows.map((row) => r.columns.map((c) => row[c.key])), ...(r.totals ? [r.columns.map((c) => r.totals![c.key] ?? "")] : [])];
  return Buffer.from("﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n", "utf8");
}

async function toXlsx(r: Report, heading: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "DevUp Finance";
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.addRow([heading]).font = { bold: true, size: 13 };
  for (const n of r.notes) ws.addRow([n]).font = { italic: true, color: { argb: "FF666666" } };
  ws.addRow([]);
  const head = ws.addRow(r.columns.map((c) => c.label));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } }; });
  for (const row of r.rows) ws.addRow(r.columns.map((c) => row[c.key] ?? ""));
  if (r.totals) ws.addRow(r.columns.map((c) => r.totals![c.key] ?? "")).font = { bold: true };
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(Math.max(c.label.length + 2, c.type === "money" ? 14 : 12), 40);
    if (c.type === "money") col.numFmt = "#,##0.00";
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function toPdf(r: Report, heading: string) {
  const fmt = (c: Col, v: unknown) => (c.type === "money" && typeof v === "number" ? v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : esc(v ?? ""));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:10.5px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;margin:28px}h1{font-size:16px;margin:0 0 4px}
    .note{color:#555;margin:2px 0}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:5px 6px;border-bottom:1px solid #e3e3e3;text-align:left;vertical-align:top}
    th{background:#f2f2f2;font-size:9.5px;text-transform:uppercase;letter-spacing:.03em}.r{text-align:right}tfoot td{font-weight:700;border-top:2px solid #111}
  </style></head><body><h1>${esc(heading)}</h1>${r.notes.map((n) => `<div class="note">${esc(n)}</div>`).join("")}
  <table><thead><tr>${r.columns.map((c) => `<th class="${c.type === "money" || c.type === "number" ? "r" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead>
  <tbody>${r.rows.map((row) => `<tr>${r.columns.map((c) => `<td class="${c.type === "money" || c.type === "number" ? "r" : ""}">${fmt(c, row[c.key])}</td>`).join("")}</tr>`).join("")}</tbody>
  ${r.totals ? `<tfoot><tr>${r.columns.map((c) => `<td class="${c.type === "money" ? "r" : ""}">${fmt(c, r.totals![c.key] ?? "")}</td>`).join("")}</tr></tfoot>` : ""}</table></body></html>`;
  const pdf = await htmlToPdf(html, { landscape: r.columns.length > 7 });
  if (!pdf) throw new AppError(503, "The PDF couldn't be made right now. Try CSV or Excel.", "PDF_UNAVAILABLE");
  return pdf;
}

const TYPES: Record<ReportFormat, string> = { csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf" };

/** Build a report, render it, and record the export. */
export async function exportReport(a: FinanceAccess, kind: ReportKind, format: ReportFormat, q: Query) {
  if (!BUILD[kind]) throw new AppError(400, "Unknown report", "UNKNOWN_REPORT");
  scopeWhere(a, q.scope); // 404s for a scope the reader can't see
  const { from, to } = range(q);
  const r = await BUILD[kind](a, q, from, to);
  const scopeName = !q.scope || q.scope === "all" ? "All of DevUp" : q.scope === "central" ? "Central DevUp" : (await prisma.startup.findUnique({ where: { id: q.scope }, select: { name: true } }))?.name ?? "Startup";
  const heading = `${r.title} — ${scopeName} — ${day(from)} to ${day(to)}`;
  const body = format === "csv" ? toCsv(r, heading) : format === "xlsx" ? await toXlsx(r, heading) : await toPdf(r, heading);
  await audit({ action: "finance.report.exported", entity: "FinanceReport", entityId: `${kind}:${format}`, actorId: a.userId, metadata: { kind, format, scope: q.scope ?? "all", from: day(from), to: day(to), rows: r.rows.length } });
  return { body, type: TYPES[format], filename: `devup-${kind}-${(q.scope ?? "all").slice(0, 8)}-${day(from)}-to-${day(to)}.${format}`, rows: r.rows.length };
}

/** The same report as JSON, to preview on screen before exporting. */
export async function previewReport(a: FinanceAccess, kind: ReportKind, q: Query) {
  if (!BUILD[kind]) throw new AppError(400, "Unknown report", "UNKNOWN_REPORT");
  scopeWhere(a, q.scope);
  const { from, to } = range(q);
  const r = await BUILD[kind](a, q, from, to);
  return { ...r, from: day(from), to: day(to), rows: r.rows.slice(0, 200), totalRows: r.rows.length };
}
