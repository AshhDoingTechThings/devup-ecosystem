import { FinanceEventKind, FinanceEventStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { FinanceAccess, assertManage, assertView, scopeWhere } from "./access";
import { parseDate } from "./money";
import { createExpense, ExpenseInput } from "./expenses.service";

/**
 * Meetings, get-togethers, workshops and trips. An event holds many costs
 * (food, travel, venue…); each cost is an Expense with source EVENT, so it
 * goes through the same approval and appears in every total.
 *
 * Event total = sum of its live costs (submitted, approved or paid), shown
 * as paid and still-to-approve/pay separately. Drafts, rejected and cancelled
 * costs are not counted.
 */

const ENTITY = "FinanceEvent";
const LIVE = ["SUBMITTED", "NEEDS_INFO", "APPROVED", "PAID"] as const;

export type EventInput = {
  scope: string;
  name: string;
  kind?: FinanceEventKind;
  date: string;
  startTime?: string | null;
  purpose?: string | null;
  location?: string | null;
  participants?: Array<{ userId?: string | null; name: string }>;
  budgetId?: string | null;
  status?: FinanceEventStatus;
  notes?: string | null;
};

function clean(input: Partial<EventInput>) {
  const data: Prisma.FinanceEventUncheckedUpdateInput = {};
  if (input.name !== undefined) {
    if (input.name.trim().length < 2) throw new AppError(400, "Give the event a name", "NAME_REQUIRED");
    data.name = input.name.trim().slice(0, 160);
  }
  if (input.kind !== undefined) data.kind = input.kind;
  if (input.date !== undefined) data.date = parseDate(input.date, "event date");
  if (input.startTime !== undefined) {
    if (input.startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)) throw new AppError(400, "Use a time like 18:30", "INVALID_TIME");
    data.startTime = input.startTime || null;
  }
  for (const k of ["purpose", "location", "notes"] as const) {
    if (input[k] !== undefined) data[k] = input[k]?.trim().slice(0, 1000) || null;
  }
  if (input.participants !== undefined) {
    const list = (input.participants ?? []).map((p) => ({ userId: p.userId || null, name: String(p.name ?? "").trim().slice(0, 120) })).filter((p) => p.name || p.userId);
    if (list.length > 200) throw new AppError(400, "Up to 200 participants", "TOO_MANY");
    data.participants = list as unknown as Prisma.InputJsonValue;
  }
  if (input.budgetId !== undefined) data.budgetId = input.budgetId || null;
  if (input.status !== undefined) data.status = input.status;
  return data;
}

async function costsFor(eventIds: string[]) {
  const rows = await prisma.expense.findMany({
    where: { source: "EVENT", sourceId: { in: eventIds }, deletedAt: null },
    select: { id: true, number: true, title: true, amountPaise: true, status: true, incurredOn: true, sourceId: true, category: { select: { name: true, group: true } }, payee: true },
    orderBy: { createdAt: "asc" },
  });
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.sourceId!, [...(by.get(r.sourceId!) ?? []), r]);
  return by;
}

function totals(costs: Array<{ amountPaise: number; status: string }>) {
  const live = costs.filter((c) => (LIVE as readonly string[]).includes(c.status));
  const paid = live.filter((c) => c.status === "PAID").reduce((s, c) => s + c.amountPaise, 0);
  const total = live.reduce((s, c) => s + c.amountPaise, 0);
  return { totalPaise: total, paidPaise: paid, pendingPaise: total - paid, costCount: live.length, waitingApproval: live.filter((c) => c.status === "SUBMITTED" || c.status === "NEEDS_INFO").length };
}

const include = { startup: { select: { id: true, name: true, code: true } } };

export async function listEvents(a: FinanceAccess, q: { scope?: string; from?: string; to?: string }) {
  const rows = await prisma.financeEvent.findMany({
    where: {
      ...scopeWhere(a, q.scope),
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: parseDate(q.from) } : {}), ...(q.to ? { lte: parseDate(q.to) } : {}) } } : {}),
    },
    include,
    orderBy: { date: "desc" },
    take: 200,
  });
  const costs = await costsFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, ...totals(costs.get(r.id) ?? []) }));
}

export async function getEvent(a: FinanceAccess, id: string) {
  const ev = await prisma.financeEvent.findUnique({ where: { id }, include });
  if (!ev) throw new AppError(404, "Not found", "NOT_FOUND");
  assertView(a, ev.startupId);
  const costs = (await costsFor([id])).get(id) ?? [];
  return { ...ev, ...totals(costs), costs };
}

export async function createEvent(a: FinanceAccess, input: EventInput) {
  const startupId = input.scope === "central" ? null : input.scope;
  assertManage(a, startupId);
  const data = clean(input);
  if (!data.name || !data.date) throw new AppError(400, "Name and date are required", "MISSING_FIELDS");
  const ev = await prisma.$transaction(async (tx) => {
    const row = await tx.financeEvent.create({ data: { ...(data as Prisma.FinanceEventUncheckedCreateInput), startupId, createdBy: a.userId } });
    await audit({ action: "finance.event.created", entity: ENTITY, entityId: row.id, actorId: a.userId, startupId: startupId ?? undefined, metadata: { name: row.name, kind: row.kind, date: row.date } }, tx);
    return row;
  });
  return getEvent(a, ev.id);
}

export async function updateEvent(a: FinanceAccess, id: string, input: Partial<EventInput>) {
  const ev = await prisma.financeEvent.findUnique({ where: { id } });
  if (!ev) throw new AppError(404, "Not found", "NOT_FOUND");
  assertManage(a, ev.startupId);
  const data = clean(input);
  await prisma.$transaction(async (tx) => {
    await tx.financeEvent.update({ where: { id }, data });
    await audit({ action: "finance.event.edited", entity: ENTITY, entityId: id, actorId: a.userId, startupId: ev.startupId ?? undefined, metadata: { fields: Object.keys(data) } }, tx);
  });
  return getEvent(a, id);
}

/** Add one cost (food, travel, venue…) to an event. It is an expense like any other, owned by the event's scope. */
export async function addCost(a: FinanceAccess, id: string, input: Omit<ExpenseInput, "scope" | "kind">) {
  const ev = await prisma.financeEvent.findUnique({ where: { id } });
  if (!ev) throw new AppError(404, "Not found", "NOT_FOUND");
  assertManage(a, ev.startupId);
  if (ev.status === "CANCELLED") throw new AppError(409, "This event was cancelled", "CANCELLED");
  return createExpense(a, { ...input, scope: ev.startupId ?? "central", businessPurpose: input.businessPurpose || ev.purpose || ev.name }, { source: "EVENT", sourceId: id });
}
