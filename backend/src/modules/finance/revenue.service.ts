import { CollaborationStatus, IncomeSource, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { FinanceAccess, assertApprove, assertManage, assertView, canView, scopeWhere } from "./access";
import { parseDate, rupeesToPaise } from "./money";
import { createExpense, ExpenseInput } from "./expenses.service";

/**
 * Money coming in, and collaborations.
 *
 * Income is counted when received (cash basis). Two sources:
 *   IncomeEntry   sponsorships, partner contributions, event income, grants,
 *                 client payments outside the B2B module…
 *   Payment       existing B2B client payments (engagements), read, not copied.
 * B2B invoices that aren't paid yet are shown as "invoiced, not received" —
 * never as income. Startups paying DevUp's internal bills are NOT income.
 *
 * Nothing here labels anyone profitable: "money in minus money out" is shown
 * with what it includes, because there is no accrual accounting behind it.
 */

const ENTITY = "FinanceIncome";
const COLLAB = "FinanceCollaboration";

/* Income */

export type IncomeInput = {
  scope: string; source: IncomeSource; title: string; payer: string; amount: string | number; receivedOn: string;
  method?: PaymentMethod | null; reference?: string | null; collaborationId?: string | null; notes?: string | null;
};

export async function addIncome(a: FinanceAccess, input: IncomeInput) {
  const startupId = input.scope === "central" ? null : input.scope;
  assertManage(a, startupId);
  if (input.title?.trim().length < 2 || input.payer?.trim().length < 2) throw new AppError(400, "Say what the money was for and who paid it", "MISSING_FIELDS");
  if (input.collaborationId) {
    const c = await prisma.collaboration.findUnique({ where: { id: input.collaborationId }, select: { id: true } });
    if (!c) throw new AppError(400, "That collaboration doesn't exist", "UNKNOWN_COLLABORATION");
  }
  const ref = input.reference?.trim() || null;
  if (ref && (await prisma.incomeEntry.findFirst({ where: { reference: ref, voidedAt: null, startupId } }))) {
    throw new AppError(409, `Money with reference ${ref} is already recorded`, "DUPLICATE_INCOME");
  }
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.incomeEntry.create({
      data: {
        startupId, source: input.source, title: input.title.trim().slice(0, 200), payer: input.payer.trim().slice(0, 200), amountPaise: rupeesToPaise(input.amount),
        receivedOn: parseDate(input.receivedOn, "date received"), method: input.method ?? null, reference: ref, collaborationId: input.collaborationId || null,
        notes: input.notes?.trim() || null, createdBy: a.userId,
      },
    });
    await audit({ action: "finance.income.recorded", entity: ENTITY, entityId: r.id, actorId: a.userId, startupId: startupId ?? undefined, metadata: { amountPaise: r.amountPaise, source: r.source } }, tx);
    return r;
  });
  return row;
}

export async function voidIncome(a: FinanceAccess, id: string, reason: string) {
  assertApprove(a);
  if (!reason?.trim()) throw new AppError(400, "Say why it's being removed", "REASON_REQUIRED");
  const r = await prisma.incomeEntry.findUnique({ where: { id } });
  if (!r || r.voidedAt) throw new AppError(404, "Not found", "NOT_FOUND");
  await prisma.$transaction(async (tx) => {
    await tx.incomeEntry.update({ where: { id }, data: { voidedAt: new Date(), voidedBy: a.userId, voidReason: reason.trim() } });
    await audit({ action: "finance.income.voided", entity: ENTITY, entityId: id, actorId: a.userId, startupId: r.startupId ?? undefined, metadata: { reason, amountPaise: r.amountPaise } }, tx);
  });
  return { voided: true };
}

/** B2B client work belongs to central DevUp: it counts in "all" and "central" views only. */
const includesB2B = (a: FinanceAccess, scope?: string) => a.viewAll && (!scope || scope === "all" || scope === "central");

/** Income received in a period, plus B2B invoiced-vs-received. */
export async function revenue(a: FinanceAccess, q: { scope?: string; from: Date; to: Date }) {
  const where = { ...scopeWhere(a, q.scope), voidedAt: null, receivedOn: { gte: q.from, lte: q.to } };
  const [entries, b2bPaid, b2bInvoiced] = await Promise.all([
    prisma.incomeEntry.findMany({ where, include: { startup: { select: { name: true } }, collaboration: { select: { name: true } } }, orderBy: { receivedOn: "desc" }, take: 500 }),
    includesB2B(a, q.scope) ? prisma.payment.findMany({ where: { paidOn: { gte: q.from, lte: q.to }, engagement: { deletedAt: null } }, include: { engagement: { select: { title: true, clientCompany: true, code: true } } }, orderBy: { paidOn: "desc" } }) : Promise.resolve([]),
    includesB2B(a, q.scope) ? prisma.invoice.findMany({ where: { status: { in: ["SENT", "PART_PAID"] }, engagement: { deletedAt: null } }, select: { total: true, engagementId: true } }) : Promise.resolve([]),
  ]);
  const bySource = new Map<string, number>();
  for (const e of entries) bySource.set(e.source, (bySource.get(e.source) ?? 0) + e.amountPaise);
  const b2bReceived = b2bPaid.reduce((s, p) => s + p.amount, 0);
  if (b2bReceived) bySource.set("B2B_CLIENT_WORK", b2bReceived);
  return {
    receivedPaise: entries.reduce((s, e) => s + e.amountPaise, 0) + b2bReceived,
    bySource: [...bySource.entries()].map(([source, amountPaise]) => ({ source, amountPaise })).sort((x, y) => y.amountPaise - x.amountPaise),
    entries,
    b2b: { receivedPaise: b2bReceived, payments: b2bPaid.map((p) => ({ id: p.id, amountPaise: p.amount, paidOn: p.paidOn, reference: p.reference, engagement: p.engagement })), invoicedNotReceivedPaise: b2bInvoiced.reduce((s, i) => s + i.total, 0) },
  };
}

/** Money received in a period — the dashboard card. Null when nothing is recorded at all. */
export async function moneyReceived(a: FinanceAccess, scope: string | undefined, from: Date, to: Date) {
  const r = await revenue(a, { scope, from, to });
  const anyEver = (await prisma.incomeEntry.count({ where: { ...scopeWhere(a, scope), voidedAt: null } })) + (includesB2B(a, scope) ? await prisma.payment.count() : 0);
  return anyEver ? r.receivedPaise : null;
}

/* Collaborations */

export type CollaborationInput = {
  name: string; partnerName: string; partnerId?: string | null; agreementId?: string | null; status?: CollaborationStatus;
  startDate?: string | null; endDate?: string | null; budget?: string | number | null; description?: string | null;
  shares?: Array<{ startupId: string; agreedContribution?: string | number | null; note?: string | null }>;
};

const collabVisible = (a: FinanceAccess, shares: Array<{ startupId: string }>) => a.viewAll || shares.some((s) => canView(a, s.startupId));

async function collabFigures(ids: string[]) {
  const [costs, income] = await Promise.all([
    prisma.expense.groupBy({ by: ["sourceId", "status"], where: { source: "COLLABORATION", sourceId: { in: ids }, deletedAt: null, status: { in: ["SUBMITTED", "NEEDS_INFO", "APPROVED", "PAID"] } }, _sum: { amountPaise: true } }),
    prisma.incomeEntry.groupBy({ by: ["collaborationId"], where: { collaborationId: { in: ids }, voidedAt: null }, _sum: { amountPaise: true } }),
  ]);
  const out = new Map(ids.map((id) => [id, { spentPaise: 0, committedPaise: 0, incomePaise: 0 }]));
  for (const c of costs) {
    const f = out.get(c.sourceId!)!;
    if (c.status === "PAID") f.spentPaise += c._sum.amountPaise ?? 0;
    else f.committedPaise += c._sum.amountPaise ?? 0;
  }
  for (const i of income) out.get(i.collaborationId!)!.incomePaise += i._sum.amountPaise ?? 0;
  return out;
}

const collabInclude = { shares: { include: { startup: { select: { id: true, name: true, code: true } } } } } satisfies Prisma.CollaborationInclude;

export async function listCollaborations(a: FinanceAccess) {
  const rows = (await prisma.collaboration.findMany({ include: collabInclude, orderBy: { createdAt: "desc" } })).filter((c) => collabVisible(a, c.shares));
  const figs = await collabFigures(rows.map((r) => r.id));
  return rows.map((r) => {
    const f = figs.get(r.id)!;
    const agreed = r.shares.reduce((s, x) => s + (x.agreedContributionPaise ?? 0), 0);
    return { ...r, ...f, agreedContributionsPaise: agreed, budgetLeftPaise: r.budgetPaise != null ? r.budgetPaise - f.spentPaise - f.committedPaise : null, netPaise: f.incomePaise - f.spentPaise };
  });
}

export async function getCollaboration(a: FinanceAccess, id: string) {
  const c = await prisma.collaboration.findUnique({ where: { id }, include: { ...collabInclude, income: { where: { voidedAt: null }, orderBy: { receivedOn: "desc" } } } });
  if (!c || !collabVisible(a, c.shares)) throw new AppError(404, "Not found", "NOT_FOUND");
  const costs = await prisma.expense.findMany({ where: { source: "COLLABORATION", sourceId: id, deletedAt: null }, select: { id: true, number: true, title: true, amountPaise: true, status: true, incurredOn: true, startup: { select: { name: true } } }, orderBy: { incurredOn: "desc" } });
  const f = (await collabFigures([id])).get(id)!;
  return { ...c, ...f, costs, netPaise: f.incomePaise - f.spentPaise };
}

function cleanCollab(input: Partial<CollaborationInput>) {
  const data: Prisma.CollaborationUncheckedUpdateInput = {};
  if (input.name !== undefined) { if (input.name.trim().length < 2) throw new AppError(400, "Name the collaboration", "NAME_REQUIRED"); data.name = input.name.trim().slice(0, 160); }
  if (input.partnerName !== undefined) { if (input.partnerName.trim().length < 2) throw new AppError(400, "Name the partner", "PARTNER_REQUIRED"); data.partnerName = input.partnerName.trim().slice(0, 160); }
  if (input.partnerId !== undefined) data.partnerId = input.partnerId || null;
  if (input.agreementId !== undefined) data.agreementId = input.agreementId || null;
  if (input.status !== undefined) data.status = input.status;
  if (input.startDate !== undefined) data.startDate = input.startDate ? parseDate(input.startDate) : null;
  if (input.endDate !== undefined) data.endDate = input.endDate ? parseDate(input.endDate) : null;
  if (input.budget !== undefined) data.budgetPaise = input.budget == null || input.budget === "" ? null : rupeesToPaise(input.budget);
  if (input.description !== undefined) data.description = input.description?.trim() || null;
  return data;
}

export async function createCollaboration(a: FinanceAccess, input: CollaborationInput) {
  assertApprove(a);
  const data = cleanCollab(input);
  const shares = (input.shares ?? []).map((s) => ({ startupId: s.startupId, agreedContributionPaise: s.agreedContribution ? rupeesToPaise(s.agreedContribution) : null, note: s.note?.trim() || null }));
  if (new Set(shares.map((s) => s.startupId)).size !== shares.length) throw new AppError(400, "Each startup can appear only once", "DUPLICATE_SHARE");
  const c = await prisma.$transaction(async (tx) => {
    const row = await tx.collaboration.create({ data: { ...(data as Prisma.CollaborationUncheckedCreateInput), createdBy: a.userId, shares: { create: shares } } });
    await audit({ action: "finance.collaboration.created", entity: COLLAB, entityId: row.id, actorId: a.userId, metadata: { name: row.name, startups: shares.map((s) => s.startupId) } }, tx);
    return row;
  });
  return getCollaboration(a, c.id);
}

export async function updateCollaboration(a: FinanceAccess, id: string, input: Partial<CollaborationInput>) {
  assertApprove(a);
  const c = await prisma.collaboration.findUnique({ where: { id } });
  if (!c) throw new AppError(404, "Not found", "NOT_FOUND");
  const data = cleanCollab(input);
  await prisma.$transaction(async (tx) => {
    await tx.collaboration.update({ where: { id }, data });
    await audit({ action: "finance.collaboration.edited", entity: COLLAB, entityId: id, actorId: a.userId, metadata: { fields: Object.keys(data) } }, tx);
  });
  return getCollaboration(a, id);
}

/** A cost of the collaboration, owned by central DevUp or one of its startups. */
export async function addCollaborationCost(a: FinanceAccess, id: string, input: ExpenseInput) {
  const c = await prisma.collaboration.findUnique({ where: { id }, include: { shares: true } });
  if (!c) throw new AppError(404, "Not found", "NOT_FOUND");
  const owner = input.scope === "central" ? null : input.scope;
  if (owner && !c.shares.some((s) => s.startupId === owner)) throw new AppError(400, "That startup isn't part of this collaboration", "NOT_IN_COLLABORATION");
  assertView(a, owner);
  return createExpense(a, { ...input, businessPurpose: input.businessPurpose || `Collaboration: ${c.name}` }, { source: "COLLABORATION", sourceId: id });
}
