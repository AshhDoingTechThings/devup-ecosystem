import { Request, Response, NextFunction } from "express";
import { FinanceRoleKind, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";

/**
 * Who may do what in the finance portal. Resolved from FinanceRole rows only.
 * A platform ADMIN or SUPER_ADMIN gets nothing here unless also granted a
 * finance role: payroll and bank details are not an admin perk.
 *
 *   CFO                      see and change everything, central and every
 *                            startup; the ONLY role that approves or pays,
 *                            and the only one that sees pay and bank details
 *   Startup finance manager  see and prepare records of their startup(s)
 *   Finance viewer           read-only; one startup, or (startupId null)
 *                            every startup and central — never pay details
 *
 * Central DevUp (startupId null) is visible only to the CFO and to a viewer
 * granted everything.
 */
export type FinanceAccess = {
  userId: string;
  isCfo: boolean;
  /** Can see every startup and central. */
  viewAll: boolean;
  viewStartups: Set<string>;
  manageStartups: Set<string>;
  roles: Array<{ id: string; role: FinanceRoleKind; startupId: string | null }>;
};

export async function financeAccessFor(userId: string): Promise<FinanceAccess> {
  const roles = await prisma.financeRole.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, role: true, startupId: true },
  });
  const isCfo = roles.some((r) => r.role === "ECOSYSTEM_CFO");
  const viewAll = isCfo || roles.some((r) => r.role === "FINANCE_VIEWER" && r.startupId === null);
  const manageStartups = new Set(roles.filter((r) => r.role === "STARTUP_FINANCE_MANAGER" && r.startupId).map((r) => r.startupId!));
  const viewStartups = new Set([...manageStartups, ...roles.filter((r) => r.role === "FINANCE_VIEWER" && r.startupId).map((r) => r.startupId!)]);
  return { userId, isCfo, viewAll, viewStartups, manageStartups, roles };
}

export const hasAnyFinanceRole = (a: FinanceAccess) => a.roles.length > 0;

/** May see records of this scope (null = central DevUp). */
export function canView(a: FinanceAccess, startupId: string | null) {
  if (a.viewAll) return true;
  return startupId !== null && a.viewStartups.has(startupId);
}

/** May create and edit records of this scope. Viewers never; managers only their startups; the CFO everywhere. */
export function canManage(a: FinanceAccess, startupId: string | null) {
  if (a.isCfo) return true;
  return startupId !== null && a.manageStartups.has(startupId);
}

/** Approve, reject, pay, void, correct, split shared costs. The CFO only (decision D5). */
export const canApprove = (a: FinanceAccess) => a.isCfo;

/** Salaries, stipends and bank details. The CFO only. */
export const canSeePay = (a: FinanceAccess) => a.isCfo;

/**
 * A Prisma filter on `startupId` limited to what the caller may see.
 * `requested`: "all" | "central" | a startup id.
 */
export function scopeWhere(a: FinanceAccess, requested?: string | null): { startupId?: string | null | Prisma.StringNullableFilter } {
  if (requested === "central") {
    if (!canView(a, null)) throw new AppError(404, "Not found", "NOT_FOUND");
    return { startupId: null };
  }
  if (requested && requested !== "all") {
    // Out-of-scope startups answer 404, not 403, so their existence is not confirmed.
    if (!canView(a, requested)) throw new AppError(404, "Not found", "NOT_FOUND");
    return { startupId: requested };
  }
  if (a.viewAll) return {};
  return { startupId: { in: [...a.viewStartups] } };
}

/** Assert or 404. Used after loading a record, so out-of-scope ids look like missing ones. */
export function assertView(a: FinanceAccess, startupId: string | null) {
  if (!canView(a, startupId)) throw new AppError(404, "Not found", "NOT_FOUND");
}

export function assertManage(a: FinanceAccess, startupId: string | null) {
  assertView(a, startupId);
  if (!canManage(a, startupId)) throw new AppError(403, "You can view these records but not change them", "FINANCE_READ_ONLY");
}

export function assertApprove(a: FinanceAccess) {
  if (!canApprove(a)) throw new AppError(403, "Only the CFO can approve, pay or correct finance records", "CFO_ONLY");
}

/* Middleware */

/** Loads req.finance. Anyone signed in may pass; routes then check what they may do. */
export const loadFinance = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, "Not authorized", "UNAUTHORIZED");
    req.finance = await financeAccessFor(req.user.id);
    next();
  } catch (err) {
    next(err);
  }
};

/** Holds any finance role. */
export const requireFinance = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.finance || !hasAnyFinanceRole(req.finance)) return next(new AppError(403, "You don't have access to finance", "FINANCE_FORBIDDEN"));
  next();
};

export const requireCfo = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.finance?.isCfo) return next(new AppError(403, "Only the CFO can do this", "CFO_ONLY"));
  next();
};
