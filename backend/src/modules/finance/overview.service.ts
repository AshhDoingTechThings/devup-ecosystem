import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { FinanceAccess, canSeePay, scopeWhere } from "./access";
import { PeriodKind, dateOnly, periodRange } from "./money";
import { headcounts } from "./expenses.service";
import { budgetSnapshot } from "./budgets.service";
import { monthlySubscriptions } from "./subscriptions.service";

/**
 * Numbers for the CFO dashboard. Every figure is read from real records; a
 * module that does not exist yet reports `null` ("not tracked yet"), never 0.
 *
 * Words used on screen, and what they mean here:
 *   Spent                 PAID expenses whose expense date is in the period
 *   Bills still to pay    APPROVED, not yet paid (as of today, any date)
 *   Waiting for approval  SUBMITTED or NEEDS_INFO (as of today)
 *   Overdue               approved, unpaid, due date before today
 *
 * Shared costs: a central DevUp bill split between startups is counted ONCE
 * in the ecosystem total (as central spending). Each startup's view adds its
 * share, shown separately as "share of shared DevUp costs".
 */

const notDeleted = { deletedAt: null } as const;

type Sum = { _sum: { amountPaise: number | null }; _count?: number };
/** The paise total of an aggregate, 0 when there were no rows. */
const paise = (a: Sum) => a._sum.amountPaise ?? 0;
const get0 = <K>(m: Map<K, number>, k: K) => m.get(k) ?? 0;

export async function visibleStartups(access: FinanceAccess) {
  return prisma.startup.findMany({
    where: access.viewAll ? {} : { id: { in: [...access.viewStartups] } },
    select: { id: true, name: true, code: true, isActive: true, type: true, logoUrl: true },
    orderBy: { name: "asc" },
  });
}

function resolvePeriod(q: { period?: PeriodKind; anchor?: string; from?: string; to?: string }) {
  const period = q.period ?? "month";
  const anchor = q.anchor ? new Date(`${q.anchor}T00:00:00Z`) : new Date();
  return { period, ...periodRange(period, Number.isNaN(anchor.getTime()) ? new Date() : anchor, { from: q.from, to: q.to }) };
}

export async function overview(access: FinanceAccess, q: { scope?: string; period?: PeriodKind; anchor?: string; from?: string; to?: string }) {
  const { period, from, to } = resolvePeriod(q);
  const scope = scopeWhere(access, q.scope);
  const singleStartup = typeof scope.startupId === "string" ? scope.startupId : null;
  const today = dateOnly(new Date());
  const inPeriod: Prisma.ExpenseWhereInput = { ...notDeleted, ...scope, incurredOn: { gte: from, lte: to } };

  const startups = await visibleStartups(access);
  const startupIds = singleStartup ? [singleStartup] : startups.map((s) => s.id);

  const [spent, toPay, overdue, waiting, claims, byCategory, byScope, shares, upcoming, recent, trendRows] = await Promise.all([
    prisma.expense.aggregate({ where: { ...inPeriod, status: "PAID" }, _sum: { amountPaise: true }, _count: true }),
    prisma.expense.aggregate({ where: { ...notDeleted, ...scope, status: "APPROVED" }, _sum: { amountPaise: true }, _count: true }),
    prisma.expense.aggregate({ where: { ...notDeleted, ...scope, status: "APPROVED", dueOn: { lt: today } }, _sum: { amountPaise: true }, _count: true }),
    prisma.expense.aggregate({ where: { ...notDeleted, ...scope, status: { in: ["SUBMITTED", "NEEDS_INFO"] } }, _sum: { amountPaise: true }, _count: true }),
    prisma.expense.aggregate({ where: { ...notDeleted, ...scope, kind: "REIMBURSEMENT", status: { in: ["SUBMITTED", "NEEDS_INFO", "APPROVED"] } }, _sum: { amountPaise: true }, _count: true }),
    prisma.expense.groupBy({ by: ["categoryId"], where: { ...inPeriod, status: "PAID" }, _sum: { amountPaise: true } }),
    prisma.expense.groupBy({ by: ["startupId"], where: { ...inPeriod, status: "PAID" }, _sum: { amountPaise: true } }),
    // Shares of central costs charged to startups, for paid central expenses in the period.
    prisma.expenseAllocation.groupBy({
      by: ["startupId"],
      where: { startupId: { in: startupIds }, expense: { ...notDeleted, startupId: null, status: "PAID", incurredOn: { gte: from, lte: to } } },
      _sum: { amountPaise: true },
    }),
    prisma.expense.findMany({
      where: { ...notDeleted, ...scope, status: "APPROVED", dueOn: { gte: today, lte: new Date(today.getTime() + 14 * 86400_000) } },
      select: { id: true, number: true, title: true, amountPaise: true, dueOn: true, startup: { select: { name: true } }, vendor: { select: { name: true } }, payee: true },
      orderBy: { dueOn: "asc" }, take: 8,
    }),
    prisma.expense.findMany({
      where: { ...notDeleted, ...scope },
      select: { id: true, number: true, title: true, amountPaise: true, status: true, kind: true, incurredOn: true, startup: { select: { name: true } }, category: { select: { name: true } } },
      orderBy: { createdAt: "desc" }, take: 8,
    }),
    trend(scope),
  ]);

  const categories = await prisma.financeCategory.findMany({ where: { id: { in: byCategory.map((c) => c.categoryId) } }, select: { id: true, name: true, group: true } });
  const catById = new Map(categories.map((c) => [c.id, c]));
  const groups = new Map<string, number>();
  for (const c of byCategory) {
    const g = catById.get(c.categoryId)?.group ?? "Other";
    groups.set(g, get0(groups, g) + paise(c));
  }

  const shareBy = new Map(shares.map((s) => [s.startupId, paise(s)]));
  const directBy = new Map(byScope.map((s) => [s.startupId, paise(s)]));
  const hc = await headcounts(startupIds);

  const perStartup = startups
    .filter((s) => startupIds.includes(s.id))
    .map((s) => ({
      id: s.id, name: s.name, code: s.code, isActive: s.isActive, type: s.type,
      spentPaise: get0(directBy, s.id),
      sharedCostSharePaise: get0(shareBy, s.id),
      peopleNow: get0(hc, s.id),
    }));

  const centralSpent = get0(directBy, null);

  return {
    period: { kind: period, from, to },
    scope: q.scope && q.scope !== "all" ? q.scope : "all",
    cards: {
      spentPaise: paise(spent),
      spentCount: spent._count,
      billsToPayPaise: paise(toPay),
      billsToPayCount: toPay._count,
      overduePaise: paise(overdue),
      overdueCount: overdue._count,
      waitingApprovalPaise: paise(waiting),
      waitingApprovalCount: waiting._count,
      claimsOpenPaise: paise(claims),
      claimsOpenCount: claims._count,
      // A startup's own spending plus its share of shared costs. Ecosystem view: each cost once.
      ...(singleStartup ? { sharedCostSharePaise: get0(shareBy, singleStartup) } : {}),
      // Modules not built yet: null means "not tracked yet", never zero.
      moneyReceivedPaise: null,
      expectedFromStartupsPaise: null,
      monthlySubscriptionsPaise: await monthlySubscriptions(access, q.scope),
      cashBalancePaise: null,
    },
    // Budgets of this view (ecosystem / central / startup) running at any time in the period.
    budget: await budgetSnapshot(access, q.scope ?? "all", from, to),
    payroll: canSeePay(access) ? await payrollSnapshot(singleStartup) : null,
    byCategoryGroup: [...groups.entries()].map(([group, amountPaise]) => ({ group, amountPaise })).sort((a, b) => b.amountPaise - a.amountPaise),
    byStartup: singleStartup ? perStartup : [{ id: "central", name: "Central DevUp operations", code: null, isActive: true, type: null, spentPaise: centralSpent, sharedCostSharePaise: 0, peopleNow: 0 }, ...perStartup],
    ecosystemTotalNote: singleStartup ? null : "Shared DevUp costs are counted once, under central operations. Each startup's share is shown beside it but not added again.",
    trend: trendRows,
    upcoming,
    recent,
    workforce: {
      startups: perStartup.length,
      peopleNow: perStartup.reduce((s, x) => s + x.peopleNow, 0),
    },
  };
}

/** Spent (paid) and approved-but-unpaid per month, for the last 12 months up to this one. */
async function trend(scope: ReturnType<typeof scopeWhere>) {
  const end = dateOnly(new Date());
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  const rows = await prisma.expense.findMany({
    where: { ...notDeleted, ...scope, status: { in: ["PAID", "APPROVED"] }, incurredOn: { gte: start, lte: end } },
    select: { amountPaise: true, status: true, incurredOn: true },
  });
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    return { month: d.toISOString().slice(0, 7), spentPaise: 0, approvedUnpaidPaise: 0 };
  });
  const idx = new Map(months.map((m, i) => [m.month, i]));
  for (const r of rows) {
    const i = idx.get(r.incurredOn.toISOString().slice(0, 7));
    if (i === undefined) continue;
    if (r.status === "PAID") months[i].spentPaise += r.amountPaise;
    else months[i].approvedUnpaidPaise += r.amountPaise;
  }
  return months;
}

/** What a normal month of pay costs, from confirmed figures only, and how many people are still unconfirmed. */
async function payrollSnapshot(startupId: string | null) {
  const today = dateOnly(new Date());
  const where = startupId ? { startupId } : {};
  const [employees, interns] = await Promise.all([
    prisma.employee.findMany({
      where: { ...where, status: { in: ["ACTIVE", "NOTICE"] } },
      select: { id: true, compensation: { where: { effectiveTo: null }, select: { monthlyGrossPaise: true }, take: 1 } },
    }),
    prisma.intern.findMany({
      where: { ...where, status: { in: ["ACTIVE", "NOTICE"] }, startDate: { lte: today }, endDate: { gte: today } },
      select: { stipendAmount: true },
    }),
  ]);
  return {
    monthlySalariesPaise: employees.reduce((s, e) => s + (e.compensation[0]?.monthlyGrossPaise ?? 0), 0),
    employees: employees.length,
    employeesWithoutConfirmedPay: employees.filter((e) => !e.compensation[0]).length,
    monthlyStipendsPaise: interns.reduce((s, i) => s + (i.stipendAmount ?? 0) * 100, 0),
    internsNow: interns.length,
    internsWithoutConfirmedStipend: interns.filter((i) => i.stipendAmount == null).length,
  };
}
