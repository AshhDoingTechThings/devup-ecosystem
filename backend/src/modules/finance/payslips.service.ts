import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { htmlToPdf } from "../../lib/pdf";
import { esc } from "../../lib/email/layout";
import { audit } from "../shared/audit.service";
import { FinanceAccess } from "./access";
import { Adjustment } from "./payrollMath";

/**
 * Payslips (salary) and stipend statements, as PDFs, plus "my pay" for staff.
 *
 * Who may open one: the CFO, or the person it is for (their linked account).
 * Only approved or paid lines have a payslip — a draft figure is not a slip.
 * These are statements of what DevUp recorded; no statutory deductions are
 * calculated (decision D11), so they are not tax documents.
 */

const VISIBLE_RUN = ["APPROVED", "PROCESSING", "PARTIALLY_PAID", "PAID"];
const money = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const month = (d: Date) => d.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

/* My pay — for the signed-in person */

export async function myPay(userId: string) {
  const [items, payouts, comp] = await Promise.all([
    prisma.payrollItem.findMany({
      where: { employee: { userId }, run: { status: { in: VISIBLE_RUN as any } } },
      include: { run: { select: { periodStart: true, status: true } }, employee: { select: { startup: { select: { name: true } } } } },
      orderBy: { periodStart: "desc" },
    }),
    prisma.stipendPayout.findMany({
      where: { intern: { userId }, status: { in: ["APPROVED", "PAID"] } },
      include: { intern: { select: { startup: { select: { name: true } } } } },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    }),
    prisma.employeeCompensation.findMany({ where: { employee: { userId }, effectiveTo: null }, select: { monthlyGrossPaise: true, effectiveFrom: true, employee: { select: { startup: { select: { name: true } } } } } }),
  ]);
  return {
    currentPay: comp.map((c) => ({ startup: c.employee.startup.name, monthlyGrossPaise: c.monthlyGrossPaise, since: c.effectiveFrom })),
    salary: items.map((i) => ({ id: i.id, startup: i.employee.startup.name, period: i.periodStart, netPaise: i.netPaise, status: i.status, paidOn: i.paidOn })),
    stipends: payouts.map((p) => ({ id: p.id, startup: p.intern.startup.name, period: new Date(Date.UTC(p.periodYear, p.periodMonth - 1, 1)), netPaise: p.netAmount * 100, status: p.status, paidOn: p.paidAt })),
  };
}

/* PDFs */

type Slip = {
  title: string; startup: string; person: string; code: string; role: string; period: Date; workedDays: number; periodDays: number;
  earnings: Array<[string, number]>; deductions: Array<[string, number]>; netPaise: number; status: string; paidOn: Date | null; paymentRef: string | null; bankLast4: string | null;
};

function slipHtml(s: Slip) {
  const row = ([k, v]: [string, number]) => `<tr><td>${esc(k)}</td><td class="r">${money(v)}</td></tr>`;
  const total = (list: Array<[string, number]>) => list.reduce((t, [, v]) => t + v, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:12px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;margin:36px}
    h1{font-size:18px;margin:0}.muted{color:#666}.r{text-align:right}
    table{width:100%;border-collapse:collapse;margin-top:14px}td,th{padding:7px 8px;border-bottom:1px solid #e5e5e5;text-align:left}
    th{font-size:11px;text-transform:uppercase;color:#666;letter-spacing:.04em}.net td{font-weight:700;font-size:14px;border-top:2px solid #111}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-top:16px}.note{margin-top:22px;font-size:10.5px;color:#777}
  </style></head><body>
    <h1>${esc(s.title)} — ${esc(month(s.period))}</h1>
    <div class="muted">${esc(s.startup)} · issued through DevUp Ecosystem</div>
    <div class="grid">
      <div><span class="muted">Name</span><br>${esc(s.person)}</div><div><span class="muted">Code</span><br>${esc(s.code)}</div>
      <div><span class="muted">Role</span><br>${esc(s.role)}</div><div><span class="muted">Days</span><br>${s.workedDays} of ${s.periodDays}</div>
    </div>
    <table><tr><th>Earnings</th><th class="r">Amount</th></tr>${s.earnings.map(row).join("")}<tr><td><b>Total earnings</b></td><td class="r"><b>${money(total(s.earnings))}</b></td></tr></table>
    ${s.deductions.length ? `<table><tr><th>Deductions</th><th class="r">Amount</th></tr>${s.deductions.map(row).join("")}</table>` : ""}
    <table><tr class="net"><td>Net pay</td><td class="r">${money(s.netPaise)}</td></tr></table>
    <div class="grid"><div><span class="muted">Status</span><br>${s.status === "PAID" ? `Paid on ${esc(s.paidOn ? s.paidOn.toISOString().slice(0, 10) : "")}` : "Approved, not yet paid"}</div>
    <div><span class="muted">Paid to</span><br>${s.bankLast4 ? `Account ending ${esc(s.bankLast4)}` : "—"}${s.paymentRef ? ` · ref ${esc(s.paymentRef)}` : ""}</div></div>
    <div class="note">A statement of pay recorded by DevUp Ecosystem. No statutory deductions (PF, ESI, TDS, professional tax) are calculated here.</div>
  </body></html>`;
}

async function render(s: Slip) {
  const pdf = await htmlToPdf(slipHtml(s));
  if (!pdf) throw new AppError(503, "The PDF couldn't be made right now. Try again in a minute.", "PDF_UNAVAILABLE");
  return pdf;
}

const allowed = (a: FinanceAccess, ownerUserId: string | null) => a.isCfo || (!!ownerUserId && ownerUserId === a.userId);

export async function payslip(a: FinanceAccess, itemId: string) {
  const i = await prisma.payrollItem.findUnique({
    where: { id: itemId },
    include: { run: true, employee: { include: { startup: { select: { name: true } }, bankAccounts: { where: { deactivatedAt: null }, select: { accountLast4: true } } } } },
  });
  if (!i || !allowed(a, i.employee.userId) || !VISIBLE_RUN.includes(i.run.status)) throw new AppError(404, "Not found", "NOT_FOUND");
  const adj = (i.adjustments as Adjustment[]) ?? [];
  const slip: Slip = {
    title: "Payslip", startup: i.employee.startup.name, person: i.employee.fullName, code: i.employee.employeeCode, role: i.employee.designation,
    period: i.periodStart, workedDays: i.workedDays, periodDays: i.periodDays,
    earnings: [...((i.components as Array<{ name: string; amountPaise: number }>) ?? []).map((c): [string, number] => [c.name, c.amountPaise]), ...adj.filter((x) => x.kind !== "DEDUCTION").map((x): [string, number] => [x.label, x.amountPaise])],
    deductions: adj.filter((x) => x.kind === "DEDUCTION").map((x): [string, number] => [x.label, x.amountPaise]),
    netPaise: i.netPaise, status: i.status, paidOn: i.paidOn, paymentRef: i.paymentRef, bankLast4: i.employee.bankAccounts[0]?.accountLast4 ?? null,
  };
  const pdf = await render(slip);
  await audit({ action: "finance.payslip.opened", entity: "FinancePayroll", entityId: i.runId, actorId: a.userId, startupId: i.startupId, metadata: { itemId } });
  return { pdf, filename: `payslip-${i.employee.employeeCode}-${i.periodStart.toISOString().slice(0, 7)}.pdf` };
}

export async function stipendStatement(a: FinanceAccess, payoutId: string) {
  const p = await prisma.stipendPayout.findUnique({
    where: { id: payoutId },
    include: { intern: { include: { startup: { select: { name: true } }, bankAccounts: { where: { deactivatedAt: null }, select: { accountLast4: true } } } } },
  });
  if (!p || !allowed(a, p.intern.userId) || !["APPROVED", "PAID"].includes(p.status)) throw new AppError(404, "Not found", "NOT_FOUND");
  const slip: Slip = {
    title: "Stipend statement", startup: p.intern.startup.name, person: p.intern.fullName, code: p.intern.internCode, role: p.intern.designation,
    period: new Date(Date.UTC(p.periodYear, p.periodMonth - 1, 1)), workedDays: Math.round(p.payableCentidays / 100), periodDays: p.workingDays,
    earnings: [["Stipend", p.grossAmount * 100], ...(p.adjustment > 0 ? [[p.adjustmentNote ?? "Adjustment", p.adjustment * 100] as [string, number]] : [])],
    deductions: p.adjustment < 0 ? [[p.adjustmentNote ?? "Adjustment", -p.adjustment * 100]] : [],
    netPaise: p.netAmount * 100, status: p.status, paidOn: p.paidAt, paymentRef: p.paymentRef, bankLast4: p.intern.bankAccounts[0]?.accountLast4 ?? null,
  };
  const pdf = await render(slip);
  await audit({ action: "finance.payslip.opened", entity: "FinancePayroll", entityId: p.payrollRunId ?? payoutId, actorId: a.userId, startupId: p.startupId, metadata: { payoutId } });
  return { pdf, filename: `stipend-${p.intern.internCode}-${p.periodYear}-${String(p.periodMonth).padStart(2, "0")}.pdf` };
}
