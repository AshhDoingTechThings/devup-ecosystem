import { FinanceRoleKind } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";

/**
 * Granting and revoking finance roles. Platform SUPER_ADMIN only (the route
 * enforces that), and:
 *   - only to an account whose email is verified — never by matching a name;
 *   - never to yourself, so whoever hands out access cannot also approve pay;
 *   - a CFO covers everything (no startup); there may be more than one, and
 *     every action is recorded under the person who took it;
 *   - a startup finance manager always has exactly one startup.
 * Revoking keeps the row (revokedAt), so who had access when stays on record.
 */

const userSummary = { id: true, email: true, role: true, emailVerifiedAt: true, lastLoginAt: true, profile: { select: { name: true } } } as const;

export async function listRoles() {
  const rows = await prisma.financeRole.findMany({
    orderBy: [{ revokedAt: { sort: "desc", nulls: "first" } }, { grantedAt: "desc" }],
    take: 200,
    include: { user: { select: userSummary }, startup: { select: { id: true, name: true, code: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    startup: r.startup,
    note: r.note,
    grantedAt: r.grantedAt,
    grantedBy: r.grantedBy,
    revokedAt: r.revokedAt,
    revokedBy: r.revokedBy,
    active: !r.revokedAt,
    user: { id: r.user.id, name: r.user.profile?.name ?? null, email: r.user.email, verified: Boolean(r.user.emailVerifiedAt), lastLoginAt: r.user.lastLoginAt },
  }));
}

/** Accounts a super admin can pick from, with whether each can be granted access. */
export async function findCandidates(q: string) {
  const term = q.trim();
  if (term.length < 2) return [];
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { contains: term, mode: "insensitive" } }, { profile: { name: { contains: term, mode: "insensitive" } } }] },
    select: userSummary,
    take: 10,
    orderBy: { createdAt: "asc" },
  });
  return users.map((u) => ({
    id: u.id,
    name: u.profile?.name ?? null,
    email: u.email,
    platformRole: u.role,
    verified: Boolean(u.emailVerifiedAt),
    lastLoginAt: u.lastLoginAt,
    canGrant: Boolean(u.emailVerifiedAt),
    whyNot: u.emailVerifiedAt ? null : "Email not verified yet — ask them to verify their email and sign in first",
  }));
}

export async function grantRole(args: { actorId: string; userId: string; role: FinanceRoleKind; startupId?: string | null; note?: string | null }) {
  const startupId = args.startupId || null;
  if (args.userId === args.actorId) {
    throw new AppError(403, "You cannot give finance access to yourself — another super admin must do it", "SELF_GRANT");
  }
  const user = await prisma.user.findUnique({ where: { id: args.userId }, select: { id: true, email: true, emailVerifiedAt: true } });
  if (!user) throw new AppError(404, "No such account", "NOT_FOUND");
  if (!user.emailVerifiedAt) {
    throw new AppError(409, "This account's email is not verified. Finance access is only given to verified accounts — ask them to verify their email and sign in first.", "ACCOUNT_NOT_VERIFIED");
  }

  if (args.role === "ECOSYSTEM_CFO" && startupId) throw new AppError(400, "The CFO role covers every startup — leave the startup empty", "CFO_IS_GLOBAL");
  if (args.role === "STARTUP_FINANCE_MANAGER" && !startupId) throw new AppError(400, "Choose the startup this person manages", "STARTUP_REQUIRED");
  if (startupId) {
    const s = await prisma.startup.findUnique({ where: { id: startupId }, select: { id: true } });
    if (!s) throw new AppError(404, "No such startup", "NOT_FOUND");
  }

  return prisma.$transaction(async (tx) => {
    const dup = await tx.financeRole.findFirst({ where: { userId: args.userId, role: args.role, startupId, revokedAt: null }, select: { id: true } });
    if (dup) throw new AppError(409, "This person already has that role", "ROLE_EXISTS");

    const row = await tx.financeRole.create({
      data: { userId: args.userId, role: args.role, startupId, grantedBy: args.actorId, note: args.note?.trim() || null },
    });
    await audit({ action: "finance.role.granted", entity: "FinanceRole", entityId: row.id, actorId: args.actorId, startupId: startupId ?? undefined, metadata: { userId: args.userId, role: args.role } }, tx);
    await tx.notification.create({
      data: {
        userId: args.userId,
        type: "FINANCE_ACCESS",
        title: "You have finance access",
        message: args.role === "ECOSYSTEM_CFO" ? "You are now the CFO in the DevUp finance portal." : "You've been given access to the DevUp finance portal.",
        link: "/finance",
      },
    });
    return row;
  });
}

export async function revokeRole(args: { actorId: string; roleId: string; reason?: string | null }) {
  const row = await prisma.financeRole.findUnique({ where: { id: args.roleId } });
  if (!row) throw new AppError(404, "No such role", "NOT_FOUND");
  if (row.revokedAt) throw new AppError(409, "Already revoked", "ALREADY_REVOKED");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.financeRole.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokedBy: args.actorId } });
    await audit({ action: "finance.role.revoked", entity: "FinanceRole", entityId: row.id, actorId: args.actorId, startupId: row.startupId ?? undefined, metadata: { userId: row.userId, role: row.role, reason: args.reason ?? null } }, tx);
    return updated;
  });
}

export async function allStartups() {
  return prisma.startup.findMany({ select: { id: true, name: true, code: true, isActive: true }, orderBy: { name: "asc" } });
}

/** Who has had finance access, and what they did with roles — for the super admin's access log. */
export async function accessLog(limit = 100) {
  return prisma.auditLog.findMany({
    where: { entity: "FinanceRole" },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 500),
  });
}
