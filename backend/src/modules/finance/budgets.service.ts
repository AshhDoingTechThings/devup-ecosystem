import { BudgetPeriod, BudgetScope, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { FinanceAccess, assertApprove, assertView, canView } from "./access";
import { PeriodKind, parseDate, periodRange, rupeesToPaise } from "./money";
import { DEFAULT_CATEGORIES } from "./categories";

/**
 * Budgets: money set aside for a scope and a period.
 *
 *   Available = Allocated − Spent − Committed
 *
 *   Spent      PAID expenses dated in the budget's period
 *   Committed  APPROVED expenses (not yet paid) dated in the period
 *
 * An expense is in exactly one of those, so nothing is counted twice.
 *
 * Scope decides which expenses count:
 *   ECOSYSTEM  every expense, central and startups, each counted once
 *   CENTRAL    central DevUp expenses (their full amount)
 *   STARTUP    the startup's own expenses PLUS its share of central costs
 *              split to it — that share is reported separately as well
 *
 * A budget has either one line for everything, or lines per category group
 * (never both), so lines never overlap. Spending in groups without a line is
 * shown as "not budgeted" rather than silently left out.
 *
 * Only the CFO creates and changes budgets; every change is audited with the
 * reason, and `version` counts revisions.
 */

const ENTITY = "FinanceBudget";
const GROUPS = [...new Set(DEFAULT_CATEGORIES.map((c) => c.group))];

type Money = { allocatedPaise: number; spentPaise: number; committedPaise: number; availablePaise: number; usedPercent: number; over: boolean };
const figures = (allocated: number, spent: number, committed: number): Money => ({
  allocatedPaise: allocated,
  spentPaise: spent,
  committedPaise: committed,
  availablePaise: allocated - spent - committed,
  usedPercent: allocated > 0 ? Math.round(((spent + committed) / allocated) * 1000) / 10 : 0,
  over: spent + committed > allocated,
});

/* Validation */

export type BudgetLineInput = { categoryGroup?: string | null; amount: string | number; note?: string | null };
export type BudgetInput = {
  name: string;
  scope: BudgetScope;
  startupId?: string | null;
  purpose?: string | null;
  period: BudgetPeriod;
  /** Any date inside the period, for WEEKLY…YEARLY. */
  anchor?: string | null;
  /** For CUSTOM. */
  from?: string | null;
  to?: string | null;
  lines: BudgetLineInput[];
  approvalLimit?: string | number | null;
  notes?: string | null;
};

const PERIOD_KIND: Record<Exclude<BudgetPeriod, "CUSTOM">, PeriodKind> = { WEEKLY: "week", MONTHLY: "month", QUARTERLY: "quarter", YEARLY: "year" };

function resolvePeriod(input: Pick<BudgetInput, "period" | "anchor" | "from" | "to">) {
  if (input.period === "CUSTOM") return periodRange("custom", new Date(), { from: input.from, to: input.to });
  const anchor = input.anchor ? parseDate(input.anchor, "period date") : new Date();
  return periodRange(PERIOD_KIND[input.period], anchor);
}

function cleanLines(lines: BudgetLineInput[]) {
  if (!lines?.length) throw new AppError(400, "Add at least one amount to the budget", "LINES_REQUIRED");
  const out = lines.map((l) => {
    const group = l.categoryGroup?.trim() || null;
    if (group && !GROUPS.includes(group)) throw new AppError(400, `"${group}" isn't a spending group`, "UNKNOWN_GROUP");
    return { categoryGroup: group, allocatedPaise: rupeesToPaise(l.amount), note: l.note?.trim() || null };
  });
  const keys = out.map((l) => l.categoryGroup ?? "*");
  if (new Set(keys).size !== keys.length) throw new AppError(400, "Each spending group can appear only once", "DUPLICATE_LINE");
  if (keys.includes("*") && keys.length > 1) {
    throw new AppError(400, "Use either one amount for everything, or amounts per spending group — not both", "MIXED_LINES");
  }
  return out;
}

async function assertScope(input: { scope: BudgetScope; startupId?: string | null }) {
  if (input.scope === "STARTUP") {
    if (!input.startupId) throw new AppError(400, "Choose the startup", "STARTUP_REQUIRED");
    const s = await prisma.startup.findUnique({ where: { id: input.startupId }, select: { id: true } });
    if (!s) throw new AppError(404, "Not found", "NOT_FOUND");
    return input.startupId;
  }
  if (input.startupId) throw new AppError(400, "Only a startup budget names a startup", "STARTUP_NOT_ALLOWED");
  return null;
}

const visibleTo = (a: FinanceAccess, b: { scope: BudgetScope; startupId: string | null }) =>
  b.scope === "STARTUP" ? canView(a, b.startupId) : a.viewAll;

/* Figures */

type BudgetRow = Prisma.BudgetGetPayload<{ include: { lines: true; startup: { select: { id: true; name: true; code: true } } } }>;

/** Spent and committed per category group for a budget's scope and period. */
async function spendingByGroup(b: { scope: BudgetScope; startupId: string | null; periodStart: Date; periodEnd: Date }) {
  const inPeriod = { gte: b.periodStart, lte: b.periodEnd };
  const where: Prisma.ExpenseWhereInput = {
    deletedAt: null, status: { in: ["PAID", "APPROVED"] }, incurredOn: inPeriod,
    ...(b.scope === "CENTRAL" ? { startupId: null } : b.scope === "STARTUP" ? { startupId: b.startupId } : {}),
  };
  const [own, shares] = await Promise.all([
    prisma.expense.findMany({ where, select: { amountPaise: true, status: true, category: { select: { group: true } } } }),
    b.scope === "STARTUP"
      ? prisma.expenseAllocation.findMany({
          where: { startupId: b.startupId, expense: { deletedAt: null, startupId: null, status: { in: ["PAID", "APPROVED"] }, incurredOn: inPeriod } },
          select: { amountPaise: true, expense: { select: { status: true, category: { select: { group: true } } } } },
        })
      : Promise.resolve([]),
  ]);
  const by = new Map<string, { spent: number; committed: number }>();
  const add = (group: string, status: string, amount: number) => {
    const g = by.get(group) ?? { spent: 0, committed: 0 };
    if (status === "PAID") g.spent += amount;
    else g.committed += amount;
    by.set(group, g);
  };
  for (const e of own) add(e.category.group, e.status, e.amountPaise);
  let sharePaise = 0;
  for (const s of shares) {
    add(s.expense.category.group, s.expense.status, s.amountPaise);
    sharePaise += s.amountPaise;
  }
  return { by, sharePaise };
}

async function withFigures(b: BudgetRow) {
  const { by, sharePaise } = await spendingByGroup(b);
  const everything = b.lines.length === 1 && b.lines[0].categoryGroup === null;
  const total = (sel: (g: { spent: number; committed: number }) => number) => [...by.values()].reduce((s, g) => s + sel(g), 0);
  const lines = b.lines.map((l) => {
    const spent = l.categoryGroup ? by.get(l.categoryGroup)?.spent ?? 0 : total((g) => g.spent);
    const committed = l.categoryGroup ? by.get(l.categoryGroup)?.committed ?? 0 : total((g) => g.committed);
    return { id: l.id, categoryGroup: l.categoryGroup, note: l.note, ...figures(l.allocatedPaise, spent, committed) };
  });
  const listed = new Set(b.lines.map((l) => l.categoryGroup));
  const unbudgeted = everything
    ? []
    : [...by.entries()].filter(([g]) => !listed.has(g)).map(([group, v]) => ({ group, spentPaise: v.spent, committedPaise: v.committed }));
  const sum = (k: "allocatedPaise" | "spentPaise" | "committedPaise") => lines.reduce((s, l) => s + l[k], 0);
  return {
    id: b.id, name: b.name, scope: b.scope, startup: b.startup, purpose: b.purpose, period: b.period,
    periodStart: b.periodStart, periodEnd: b.periodEnd, approvalLimitPaise: b.approvalLimitPaise, notes: b.notes,
    version: b.version, archivedAt: b.archivedAt, createdAt: b.createdAt,
    totals: figures(sum("allocatedPaise"), sum("spentPaise"), sum("committedPaise")),
    lines,
    unbudgeted,
    sharedCostSharePaise: b.scope === "STARTUP" ? sharePaise : null,
  };
}

const include = { lines: { orderBy: { categoryGroup: "asc" as const } }, startup: { select: { id: true, name: true, code: true } } };

/* Reading */

export async function listBudgets(a: FinanceAccess, q: { scope?: string; current?: boolean; archived?: boolean }) {
  const today = new Date();
  const rows = await prisma.budget.findMany({
    where: {
      ...(q.archived ? {} : { archivedAt: null }),
      ...(q.current ? { periodStart: { lte: today }, periodEnd: { gte: today } } : {}),
      ...scopeFilter(q.scope),
    },
    include,
    orderBy: [{ periodStart: "desc" }, { name: "asc" }],
    take: 200,
  });
  return Promise.all(rows.filter((b) => visibleTo(a, b)).map(withFigures));
}

/** "all" → ecosystem budgets, "central" → central, a startup id → that startup's. */
function scopeFilter(scope?: string): Prisma.BudgetWhereInput {
  if (!scope) return {};
  if (scope === "all") return { scope: "ECOSYSTEM" };
  if (scope === "central") return { scope: "CENTRAL" };
  return { scope: "STARTUP", startupId: scope };
}

export async function getBudget(a: FinanceAccess, id: string) {
  const b = await prisma.budget.findUnique({ where: { id }, include });
  if (!b || !visibleTo(a, b)) throw new AppError(404, "Not found", "NOT_FOUND");
  const history = await prisma.auditLog.findMany({ where: { entity: ENTITY, entityId: id }, orderBy: { createdAt: "asc" } });
  return { ...(await withFigures(b)), history: history.map((h) => ({ at: h.createdAt, action: h.action, by: h.adminId, details: h.metadata })) };
}

/** Budgets of a dashboard scope that overlap a date range, summed — for the overview card. */
export async function budgetSnapshot(a: FinanceAccess, scope: string, from: Date, to: Date) {
  const rows = await prisma.budget.findMany({ where: { archivedAt: null, periodStart: { lte: to }, periodEnd: { gte: from }, ...scopeFilter(scope) }, include });
  const visible = rows.filter((b) => visibleTo(a, b));
  if (!visible.length) return null;
  const all = await Promise.all(visible.map(withFigures));
  const sum = (k: "allocatedPaise" | "spentPaise" | "committedPaise") => all.reduce((s, b) => s + b.totals[k], 0);
  return { count: all.length, overCount: all.filter((b) => b.totals.over).length, ...figures(sum("allocatedPaise"), sum("spentPaise"), sum("committedPaise")) };
}

/* Writing — the CFO only */

export async function createBudget(a: FinanceAccess, input: BudgetInput) {
  assertApprove(a);
  const startupId = await assertScope(input);
  const { from, to } = resolvePeriod(input);
  const lines = cleanLines(input.lines);
  const name = input.name?.trim();
  if (!name || name.length < 2) throw new AppError(400, "Give the budget a name", "NAME_REQUIRED");
  const b = await prisma.$transaction(async (tx) => {
    const row = await tx.budget.create({
      data: {
        name: name.slice(0, 120), scope: input.scope, startupId, purpose: input.purpose?.trim() || null, period: input.period,
        periodStart: from, periodEnd: to, approvalLimitPaise: input.approvalLimit ? rupeesToPaise(input.approvalLimit) : null,
        notes: input.notes?.trim() || null, createdBy: a.userId, lines: { create: lines },
      },
    });
    await audit({ action: "finance.budget.created", entity: ENTITY, entityId: row.id, actorId: a.userId, startupId: startupId ?? undefined, metadata: { name, scope: input.scope, from, to, lines } }, tx);
    return row;
  });
  return getBudget(a, b.id);
}

/** Change amounts or details. Changing amounts needs a reason, kept with the before and after. */
export async function reviseBudget(a: FinanceAccess, id: string, input: { name?: string; lines?: BudgetLineInput[]; approvalLimit?: string | number | null; notes?: string | null; reason?: string | null }) {
  assertApprove(a);
  const b = await prisma.budget.findUnique({ where: { id }, include: { lines: true } });
  if (!b) throw new AppError(404, "Not found", "NOT_FOUND");
  assertView(a, b.startupId);
  if (b.archivedAt) throw new AppError(409, "This budget is archived", "ARCHIVED");
  const lines = input.lines ? cleanLines(input.lines) : null;
  if (lines && !input.reason?.trim()) throw new AppError(400, "Say why the budget is changing — it's kept with the revision", "REASON_REQUIRED");
  const before = b.lines.map((l) => ({ categoryGroup: l.categoryGroup, allocatedPaise: l.allocatedPaise }));
  await prisma.$transaction(async (tx) => {
    if (lines) {
      await tx.budgetLine.deleteMany({ where: { budgetId: id } });
      await tx.budgetLine.createMany({ data: lines.map((l) => ({ ...l, budgetId: id })) });
    }
    await tx.budget.update({
      where: { id },
      data: {
        ...(input.name?.trim() ? { name: input.name.trim().slice(0, 120) } : {}),
        ...(input.approvalLimit !== undefined ? { approvalLimitPaise: input.approvalLimit ? rupeesToPaise(input.approvalLimit) : null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        ...(lines ? { version: { increment: 1 } } : {}),
      },
    });
    await audit({
      action: lines ? "finance.budget.revised" : "finance.budget.edited", entity: ENTITY, entityId: id, actorId: a.userId, startupId: b.startupId ?? undefined,
      metadata: { reason: input.reason ?? null, ...(lines ? { before, after: lines.map((l) => ({ categoryGroup: l.categoryGroup, allocatedPaise: l.allocatedPaise })) } : {}) },
    }, tx);
  });
  return getBudget(a, id);
}

export async function archiveBudget(a: FinanceAccess, id: string) {
  assertApprove(a);
  const b = await prisma.budget.findUnique({ where: { id } });
  if (!b) throw new AppError(404, "Not found", "NOT_FOUND");
  if (b.archivedAt) return getBudget(a, id);
  await prisma.$transaction(async (tx) => {
    await tx.budget.update({ where: { id }, data: { archivedAt: new Date() } });
    await audit({ action: "finance.budget.archived", entity: ENTITY, entityId: id, actorId: a.userId, startupId: b.startupId ?? undefined }, tx);
  });
  return getBudget(a, id);
}

export const spendingGroups = () => GROUPS;
