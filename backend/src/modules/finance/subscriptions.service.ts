import { Prisma, RecurringFrequency, SubscriptionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { FinanceAccess, assertManage, assertView, scopeWhere } from "./access";
import { dateOnly, parseDate, rupeesToPaise } from "./money";
import { createExpense, ensureDefaultCategories } from "./expenses.service";

/**
 * Software and services DevUp and its startups pay for, and who uses them.
 *
 * A seat counts as used only when someone is assigned to it here (an admin's
 * confirmation). A purchased seat with nobody assigned is reported as unused —
 * never assumed to be in use.
 *
 * Each payment is an Expense with source SUBSCRIPTION, so subscription
 * spending shows up in every total, budget and chart like any other cost.
 */

const ENTITY = "FinanceSubscription";

export type SubscriptionInput = {
  scope: string;
  name: string;
  provider: string;
  plan?: string | null;
  billingCycle?: RecurringFrequency;
  cost: string | number;
  currency?: string;
  seatsPurchased?: number | null;
  renewalOn?: string | null;
  paymentMethodNote?: string | null;
  responsibleUserId?: string | null;
  categoryId?: string | null;
  notes?: string | null;
};

/** What a subscription costs in an average month, in paise. */
export function monthlyEquivalent(s: { billingCycle: RecurringFrequency; costPaise: number }) {
  switch (s.billingCycle) {
    case "WEEKLY": return Math.round((s.costPaise * 52) / 12);
    case "QUARTERLY": return Math.round(s.costPaise / 3);
    case "YEARLY": return Math.round(s.costPaise / 12);
    default: return s.costPaise;
  }
}

const CYCLE_MONTHS: Record<RecurringFrequency, number> = { WEEKLY: 0, MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
function nextRenewal(from: Date, cycle: RecurringFrequency) {
  if (cycle === "WEEKLY") return new Date(from.getTime() + 7 * 86400_000);
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + CYCLE_MONTHS[cycle], from.getUTCDate()));
}

/* Card numbers never belong here: a 12+ digit run in the payment note is refused. */
function cleanPaymentNote(note?: string | null) {
  const n = note?.trim() || null;
  if (n && /\d[\d\s-]{11,}\d/.test(n)) throw new AppError(400, "Describe the payment method (e.g. \"company card ending 4242\") — never enter a full card number", "CARD_NUMBER");
  return n?.slice(0, 120) ?? null;
}

type SubData = Prisma.SubscriptionUncheckedUpdateInput;

async function clean(a: FinanceAccess, input: Partial<SubscriptionInput>) {
  const data: SubData = {};
  if (input.scope !== undefined) {
    const startupId = input.scope === "central" ? null : input.scope;
    assertManage(a, startupId);
    data.startupId = startupId;
  }
  cleanNames(input, data);
  cleanCost(input, data);
  cleanDetails(input, data);
  return data;
}

function cleanNames(input: Partial<SubscriptionInput>, data: SubData) {
  for (const k of ["name", "provider"] as const) {
    if (input[k] === undefined) continue;
    const v = input[k]!.trim();
    if (v.length < 2) throw new AppError(400, `Enter the ${k === "name" ? "subscription name" : "provider"}`, "FIELD_REQUIRED");
    data[k] = v.slice(0, 120);
  }
  if (input.plan !== undefined) data.plan = input.plan?.trim() || null;
}

function cleanCost(input: Partial<SubscriptionInput>, data: SubData) {
  if (input.billingCycle !== undefined) data.billingCycle = input.billingCycle;
  if (input.cost !== undefined) data.costPaise = rupeesToPaise(input.cost);
  if (input.currency !== undefined) data.currency = (input.currency || "INR").toUpperCase().slice(0, 3);
  if (input.seatsPurchased === undefined) return;
  const n = input.seatsPurchased;
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > 10000)) throw new AppError(400, "Seats must be a whole number", "INVALID_SEATS");
  data.seatsPurchased = n;
}

function cleanDetails(input: Partial<SubscriptionInput>, data: SubData) {
  if (input.renewalOn !== undefined) data.renewalOn = input.renewalOn ? parseDate(input.renewalOn, "renewal date") : null;
  if (input.paymentMethodNote !== undefined) data.paymentMethodNote = cleanPaymentNote(input.paymentMethodNote);
  if (input.responsibleUserId !== undefined) data.responsibleUserId = input.responsibleUserId || null;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.categoryId) data.categoryId = input.categoryId;
}

const include = {
  startup: { select: { id: true, name: true, code: true } },
  seats: { where: { removedAt: null }, include: { user: { select: { id: true, email: true, profile: { select: { name: true } } } } }, orderBy: { assignedAt: "asc" as const } },
} satisfies Prisma.SubscriptionInclude;
type SubRow = Prisma.SubscriptionGetPayload<{ include: typeof include }>;

function present(s: SubRow) {
  return {
    ...s,
    monthlyPaise: monthlyEquivalent(s),
    seatsAssigned: s.seats.length,
    seatsUnassigned: s.seatsPurchased != null ? Math.max(0, s.seatsPurchased - s.seats.length) : null,
    seats: s.seats.map((x) => ({ id: x.id, userId: x.userId, name: x.user?.profile?.name ?? x.name ?? x.user?.email ?? x.email, email: x.user?.email ?? x.email, startupId: x.startupId, assignedAt: x.assignedAt, note: x.note })),
  };
}

export async function listSubscriptions(a: FinanceAccess, scope?: string) {
  const rows = await prisma.subscription.findMany({ where: { ...scopeWhere(a, scope) }, include, orderBy: [{ status: "asc" }, { name: "asc" }] });
  const subs = rows.map(present);
  const active = subs.filter((s) => s.status === "ACTIVE");
  return {
    subscriptions: subs,
    totals: { activeCount: active.length, monthlyPaise: active.reduce((t, s) => t + s.monthlyPaise, 0), yearlyPaise: active.reduce((t, s) => t + s.monthlyPaise * 12, 0) },
    alerts: await alerts(subs),
  };
}

export async function getSubscription(a: FinanceAccess, id: string) {
  const s = await prisma.subscription.findUnique({ where: { id }, include });
  if (!s) throw new AppError(404, "Not found", "NOT_FOUND");
  assertView(a, s.startupId);
  const charges = await prisma.expense.findMany({
    where: { source: "SUBSCRIPTION", sourceId: id, deletedAt: null },
    select: { id: true, number: true, amountPaise: true, status: true, incurredOn: true, paymentRef: true },
    orderBy: { incurredOn: "desc" },
  });
  const history = await prisma.auditLog.findMany({ where: { entity: ENTITY, entityId: id }, orderBy: { createdAt: "asc" } });
  return { ...present(s), charges, history: history.map((h) => ({ at: h.createdAt, action: h.action, by: h.adminId, details: h.metadata })) };
}

export async function createSubscription(a: FinanceAccess, input: SubscriptionInput) {
  const data = await clean(a, input);
  if (!data.categoryId) {
    await ensureDefaultCategories();
    data.categoryId = (await prisma.financeCategory.findUnique({ where: { key: "software" } }))!.id;
  }
  const s = await prisma.$transaction(async (tx) => {
    const row = await tx.subscription.create({ data: { ...(data as Prisma.SubscriptionUncheckedCreateInput), createdBy: a.userId } });
    await audit({ action: "finance.subscription.created", entity: ENTITY, entityId: row.id, actorId: a.userId, startupId: row.startupId ?? undefined, metadata: { name: row.name, provider: row.provider, costPaise: row.costPaise, cycle: row.billingCycle } }, tx);
    return row;
  });
  return getSubscription(a, s.id);
}

export async function updateSubscription(a: FinanceAccess, id: string, input: Partial<SubscriptionInput> & { status?: SubscriptionStatus; cancelledOn?: string | null }) {
  const s = await prisma.subscription.findUnique({ where: { id } });
  if (!s) throw new AppError(404, "Not found", "NOT_FOUND");
  assertManage(a, s.startupId);
  const data = await clean(a, input);
  if (input.status !== undefined) {
    data.status = input.status;
    data.cancelledAt = input.status === "CANCELLED" ? (input.cancelledOn ? parseDate(input.cancelledOn, "cancellation date") : dateOnly(new Date())) : null;
  }
  const changes = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { from: (s as any)[k], to: v }]));
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({ where: { id }, data });
    await audit({ action: data.status === "CANCELLED" ? "finance.subscription.cancelled" : "finance.subscription.edited", entity: ENTITY, entityId: id, actorId: a.userId, startupId: s.startupId ?? undefined, metadata: { changes } }, tx);
  });
  return getSubscription(a, id);
}

/* Seats */

export async function assignSeat(a: FinanceAccess, id: string, input: { userId?: string | null; name?: string | null; email?: string | null; startupId?: string | null; note?: string | null }) {
  const s = await prisma.subscription.findUnique({ where: { id }, include: { seats: { where: { removedAt: null } } } });
  if (!s) throw new AppError(404, "Not found", "NOT_FOUND");
  assertManage(a, s.startupId);
  if (s.status === "CANCELLED") throw new AppError(409, "This subscription is cancelled", "CANCELLED");
  if (!input.userId && !input.name?.trim()) throw new AppError(400, "Choose a person, or enter their name", "PERSON_REQUIRED");
  if (s.seatsPurchased != null && s.seats.length >= s.seatsPurchased) throw new AppError(409, `All ${s.seatsPurchased} seats are assigned. Remove someone or record more seats first.`, "NO_FREE_SEAT");
  if (input.userId) {
    const u = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!u) throw new AppError(404, "No such account", "NOT_FOUND");
    if (s.seats.some((x) => x.userId === input.userId)) throw new AppError(409, "This person already has a seat", "ALREADY_ASSIGNED");
  }
  const seat = await prisma.$transaction(async (tx) => {
    const row = await tx.subscriptionSeat.create({
      data: { subscriptionId: id, userId: input.userId || null, name: input.name?.trim() || null, email: input.email?.trim() || null, startupId: input.startupId || s.startupId, confirmedBy: a.userId, note: input.note?.trim() || null },
    });
    await audit({ action: "finance.subscription.seat_assigned", entity: ENTITY, entityId: id, actorId: a.userId, startupId: s.startupId ?? undefined, metadata: { seatId: row.id, userId: row.userId, name: row.name } }, tx);
    return row;
  });
  return seat;
}

export async function removeSeat(a: FinanceAccess, seatId: string) {
  const seat = await prisma.subscriptionSeat.findUnique({ where: { id: seatId }, include: { subscription: { select: { id: true, startupId: true } } } });
  if (!seat || seat.removedAt) throw new AppError(404, "Not found", "NOT_FOUND");
  assertManage(a, seat.subscription.startupId);
  await prisma.$transaction(async (tx) => {
    await tx.subscriptionSeat.update({ where: { id: seatId }, data: { removedAt: new Date() } });
    await audit({ action: "finance.subscription.seat_removed", entity: ENTITY, entityId: seat.subscription.id, actorId: a.userId, startupId: seat.subscription.startupId ?? undefined, metadata: { seatId, userId: seat.userId, name: seat.name } }, tx);
  });
  return { removed: true };
}

/* Charges */

/** Record a payment for this subscription. It becomes an expense; the renewal date moves on one cycle. */
export async function recordCharge(a: FinanceAccess, id: string, input: { amount?: string | number | null; on: string; paid?: boolean; paymentRef?: string | null }) {
  const s = await prisma.subscription.findUnique({ where: { id } });
  if (!s) throw new AppError(404, "Not found", "NOT_FOUND");
  assertManage(a, s.startupId);
  const on = parseDate(input.on, "charge date");
  const amount = input.amount != null && input.amount !== "" ? input.amount : s.costPaise / 100;
  const expense = await createExpense(a, {
    scope: s.startupId ?? "central", title: `${s.name}${s.plan ? ` (${s.plan})` : ""} — ${on.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}`,
    categoryId: s.categoryId, payee: s.provider, amount, incurredOn: input.on,
    action: input.paid && a.isCfo ? "paid" : "submit", paymentRef: input.paymentRef ?? null, notes: s.paymentMethodNote,
  }, { source: "SUBSCRIPTION", sourceId: s.id });
  if (s.renewalOn && on >= new Date(s.renewalOn.getTime() - 3 * 86400_000) && s.billingCycle !== "WEEKLY") {
    await prisma.subscription.update({ where: { id }, data: { renewalOn: nextRenewal(s.renewalOn, s.billingCycle) } });
  }
  return expense;
}

/* Alerts */

const norm = (v?: string | null) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

type Alert = { kind: string; subscriptionId: string; name: string; message: string };

/** Alerts about one subscription on its own (duplicates are found across all of them). */
function alertsFor(s: ReturnType<typeof present>, charges: Array<{ amountPaise: number; incurredOn: Date }>, today: Date, soon: Date): Alert[] {
  const out: Alert[] = [];
  const active = s.status === "ACTIVE";
  if (active && s.renewalOn && s.renewalOn >= today && s.renewalOn <= soon) {
    out.push({ kind: "RENEWAL_SOON", subscriptionId: s.id, name: s.name, message: `Renews on ${s.renewalOn.toISOString().slice(0, 10)}` });
  }
  if (active && s.seatsUnassigned) {
    out.push({ kind: "UNASSIGNED_SEATS", subscriptionId: s.id, name: s.name, message: `${s.seatsUnassigned} of ${s.seatsPurchased} seats have nobody assigned` });
  }
  if (s.status === "CANCELLED" && s.cancelledAt && charges.some((c) => c.incurredOn > s.cancelledAt!)) {
    out.push({ kind: "CHARGED_AFTER_CANCEL", subscriptionId: s.id, name: s.name, message: "Charged after it was cancelled" });
  }
  const [prev, last] = charges.slice(-2);
  if (charges.length >= 2 && last.amountPaise > prev.amountPaise * 1.1) {
    out.push({ kind: "COST_INCREASE", subscriptionId: s.id, name: s.name, message: `Last charge ₹${last.amountPaise / 100} was up from ₹${prev.amountPaise / 100}` });
  }
  return out;
}

async function alerts(subs: ReturnType<typeof present>[]) {
  const out: Alert[] = [];
  const today = dateOnly(new Date());
  const soon = new Date(today.getTime() + 14 * 86400_000);
  const ids = subs.map((s) => s.id);
  const charges = await prisma.expense.findMany({
    where: { source: "SUBSCRIPTION", sourceId: { in: ids }, deletedAt: null, status: { in: ["SUBMITTED", "NEEDS_INFO", "APPROVED", "PAID"] } },
    select: { sourceId: true, amountPaise: true, incurredOn: true },
    orderBy: { incurredOn: "asc" },
  });
  const bySub = new Map<string, typeof charges>();
  for (const c of charges) bySub.set(c.sourceId!, [...(bySub.get(c.sourceId!) ?? []), c]);

  const dupKey = new Map<string, string[]>();
  for (const s of subs) {
    out.push(...alertsFor(s, bySub.get(s.id) ?? [], today, soon));
    if (s.status === "ACTIVE") {
      const k = `${norm(s.provider)}|${norm(s.plan)}`;
      dupKey.set(k, [...(dupKey.get(k) ?? []), s.id]);
    }
  }
  for (const group of dupKey.values()) {
    if (group.length < 2) continue;
    for (const id of group) {
      const s = subs.find((x) => x.id === id)!;
      out.push({ kind: "POSSIBLE_DUPLICATE", subscriptionId: id, name: s.name, message: `${group.length} active subscriptions to the same provider and plan` });
    }
  }
  return out;
}

/** Active subscriptions' average monthly cost in a dashboard scope (null when none are recorded). */
export async function monthlySubscriptions(a: FinanceAccess, scope?: string) {
  const rows = await prisma.subscription.findMany({ where: { status: "ACTIVE", ...scopeWhere(a, scope) }, select: { billingCycle: true, costPaise: true } });
  return rows.length ? rows.reduce((t, s) => t + monthlyEquivalent(s), 0) : null;
}

/** Who uses what: every active seat, with the software, startup, plan and renewal. */
export async function seatUsage(a: FinanceAccess, scope?: string) {
  const subs = await prisma.subscription.findMany({ where: { status: { not: "CANCELLED" }, ...scopeWhere(a, scope) }, include, orderBy: { name: "asc" } });
  const startups = new Map((await prisma.startup.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  return subs.flatMap((s) =>
    present(s).seats.map((seat) => ({
      subscriptionId: s.id, software: s.name, provider: s.provider, plan: s.plan, renewalOn: s.renewalOn,
      startup: seat.startupId ? startups.get(seat.startupId) ?? "—" : "Central DevUp", person: seat.name, email: seat.email,
    })),
  );
}
