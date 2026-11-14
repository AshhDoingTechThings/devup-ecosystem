import { randomBytes, createHash } from "crypto";
import { AffiliationKind, JoinRequestStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { logger } from "../../middleware/logger";
import { nextEmployeeCode, nextInternCode } from "../../lib/numbering";
import { Emails } from "../../lib/email/templates";
import { audit } from "../shared/audit.service";
import { notify, notifyTenantRoles } from "../shared/notification.service";
import { deliverOfferLetter, offerReasonText, OfferResult } from "./offerLetter.service";

/**
 * Startup affiliation: someone says "I work at this startup", the startup's
 * admins decide, and only an approval grants anything.
 *
 * Three separate things are tracked, on purpose:
 *   - the request        StartupJoinRequest.status   (did they ask, what was decided)
 *   - the access         StartupMember.status        (may they enter right now)
 *   - the employment     Employee/Intern.status      (are they on the team)
 * The platform role (User.role) is never touched — being an intern at one
 * startup says nothing about what someone may do on DevUp as a whole.
 */

export const OPEN_STATUSES: JoinRequestStatus[] = ["PENDING", "NEEDS_INFO"];
const STAFF_ROLES = ["OWNER", "FOUNDER", "ADMIN", "HR", "RECRUITER", "MANAGER"];
const SELF_SERVICE_ROLES = ["EMPLOYEE", "INTERN", "MEMBER"] as const;
/** Who hears about a new request: the people allowed to decide it. */
const REVIEWER_ROLES = ["OWNER", "FOUNDER", "ADMIN", "HR"];
export const PERSON_ACTIVE = ["ACTIVE", "NOTICE"] as const;

const insensitive = (email: string) => ({ equals: email, mode: "insensitive" as const });
const hashedToken = () => createHash("sha256").update(randomBytes(32)).digest("hex");

const roleFor = (kind: AffiliationKind) => (kind === "INTERN" ? "INTERN" : "EMPLOYEE");

/** Where an active member lands. Staff go to the workspace; everyone else to their own dashboard. */
export function destinationFor(code: string, role: string) {
  if (STAFF_ROLES.includes(role)) return `/s/${code}`;
  if (role === "INTERN") return `/dashboard/internship?startup=${code}`;
  return `/dashboard/employment?startup=${code}`;
}

function parseDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) throw new AppError(400, `Invalid ${field}`, "INVALID_DATE");
  return d;
}

function trimOrNull(v: unknown, max: number) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// ─── What the requester sees ────────────────────────────────────────────

/** Startups someone can say they work at: live, verified, with a workspace code. */
export async function joinableStartups(userId: string) {
  const [startups, requests, seats] = await Promise.all([
    prisma.startup.findMany({
      where: { isActive: true, isVerified: true, code: { not: null } },
      select: {
        id: true, name: true, logoUrl: true, tagline: true, description: true,
        domain: true, type: true, location: true, city: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.startupJoinRequest.findMany({ where: { userId }, select: { startupId: true, status: true, kind: true } }),
    prisma.startupMember.findMany({ where: { userId }, select: { startupId: true, status: true, role: true } }),
  ]);

  return startups.map((s) => {
    const seat = seats.find((m) => m.startupId === s.id);
    const request = requests.find((r) => r.startupId === s.id);
    let affiliation: { status: string; kind: string | null } | null = null;
    if (seat?.status === "ACTIVE") affiliation = { status: "ACTIVE", kind: seat.role };
    else if (request && OPEN_STATUSES.includes(request.status)) affiliation = { status: request.status, kind: request.kind };
    else if (seat?.status === "DEACTIVATED") affiliation = { status: "DEACTIVATED", kind: seat.role };
    else if (request?.status === "REJECTED") affiliation = { status: "REJECTED", kind: request.kind };
    else if (seat?.status === "INVITED") affiliation = { status: "INVITED", kind: seat.role };

    return {
      id: s.id,
      name: s.name,
      logoUrl: s.logoUrl,
      tagline: s.tagline,
      description: s.description && s.description.length > 220 ? `${s.description.slice(0, 217)}…` : s.description,
      category: s.domain,
      type: s.type,
      location: s.city ?? s.location,
      affiliation,
    };
  });
}

/**
 * Every startup this person is connected to, one row each, with what they may
 * do there. Built from the server's own records — the client never says what
 * its status is.
 */
export async function myAffiliations(userId: string) {
  const [user, seats, requests] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true, role: true } }),
    prisma.startupMember.findMany({
      where: { userId },
      select: {
        role: true, status: true, joinedAt: true, deactivatedAt: true,
        startup: { select: { id: true, name: true, code: true, logoUrl: true, isActive: true } },
      },
    }),
    prisma.startupJoinRequest.findMany({
      where: { userId, status: { not: "CANCELLED" } },
      select: {
        id: true, kind: true, status: true, reviewNote: true, submittedAt: true, reviewedAt: true,
        designation: true, department: true, fullName: true, phone: true, college: true,
        joiningDate: true, endDate: true, note: true,
        startup: { select: { id: true, name: true, code: true, logoUrl: true, isActive: true } },
      },
    }),
  ]);

  const byStartup = new Map<string, any>();

  for (const r of requests) {
    byStartup.set(r.startup.id, {
      startup: r.startup,
      status: r.status,
      kind: r.kind,
      role: null,
      requestId: r.id,
      reviewNote: r.reviewNote,
      designation: r.designation,
      department: r.department,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      // Their own answers, so an "information requested" form can be prefilled.
      details: {
        fullName: r.fullName, phone: r.phone, college: r.college,
        joiningDate: r.joiningDate, endDate: r.endDate, note: r.note,
      },
    });
  }

  for (const s of seats) {
    const existing = byStartup.get(s.startup.id);
    // An open request outranks a deactivated or pending-invite seat: it is
    // the thing they are currently waiting on.
    const requestIsOpen = existing && OPEN_STATUSES.includes(existing.status);
    if (s.status === "ACTIVE" || !requestIsOpen) {
      byStartup.set(s.startup.id, {
        ...(existing ?? {}),
        startup: s.startup,
        status: s.status,
        role: s.role,
        kind: s.role === "INTERN" ? "INTERN" : s.role === "EMPLOYEE" ? "EMPLOYEE" : existing?.kind ?? null,
        joinedAt: s.joinedAt,
        deactivatedAt: s.deactivatedAt,
      });
    }
  }

  const items = [...byStartup.values()].map((item) => {
    const canEnter = item.status === "ACTIVE" && item.startup.isActive && Boolean(item.startup.code);
    return {
      ...item,
      startup: { id: item.startup.id, name: item.startup.name, code: item.startup.code, logoUrl: item.startup.logoUrl },
      canEnter,
      destination: canEnter ? destinationFor(item.startup.code, item.role) : null,
    };
  });

  const order = ["ACTIVE", "NEEDS_INFO", "PENDING", "INVITED", "REJECTED", "DEACTIVATED"];
  items.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.startup.name.localeCompare(b.startup.name));

  return {
    emailVerified: Boolean(user?.emailVerifiedAt),
    isPlatformAdmin: user?.role === "ADMIN" || user?.role === "SUPER_ADMIN",
    items,
  };
}

export interface RequestInput {
  startupId: string;
  kind: AffiliationKind;
  fullName?: string;
  phone?: string;
  department?: string;
  designation?: string;
  college?: string;
  joiningDate?: string;
  endDate?: string;
  note?: string;
}

function requestFields(kind: AffiliationKind, input: Partial<RequestInput>, fallbackName: string) {
  const joiningDate = parseDate(input.joiningDate, "joining date");
  const endDate = kind === "INTERN" ? parseDate(input.endDate, "end date") : null;
  if (joiningDate && endDate && endDate <= joiningDate) {
    throw new AppError(400, "The internship end date must be after the start date", "INVALID_DATE");
  }
  return {
    fullName: trimOrNull(input.fullName, 120) ?? fallbackName,
    phone: trimOrNull(input.phone, 30),
    department: trimOrNull(input.department, 120),
    designation: trimOrNull(input.designation, 120),
    college: kind === "INTERN" ? trimOrNull(input.college, 200) : null,
    joiningDate,
    endDate,
    note: trimOrNull(input.note, 1000),
  };
}

/**
 * Ask to join a startup. Creates a PENDING request and nothing else.
 *
 * Identity comes from the signed-in account: the email recorded is the
 * account's verified address, so nobody can file a request as someone else by
 * editing the body. Fields like `status`, `role` or `userId` in the body are
 * never read.
 */
export async function submitRequest(userId: string, input: RequestInput) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerifiedAt: true, profile: { select: { name: true } } },
  });
  if (!user) throw new AppError(401, "Not authorized", "UNAUTHORIZED");
  if (!user.emailVerifiedAt) {
    throw new AppError(
      403,
      "Verify your email address before asking to join a startup.",
      "EMAIL_NOT_VERIFIED"
    );
  }

  const startup = await prisma.startup.findFirst({
    where: { id: input.startupId, isActive: true, isVerified: true, code: { not: null } },
    select: { id: true, name: true, code: true },
  });
  if (!startup) throw new AppError(404, "Startup not found", "NOT_FOUND");

  const email = user.email.trim().toLowerCase();

  const seat = await prisma.startupMember.findFirst({
    where: { startupId: startup.id, OR: [{ userId }, { email: insensitive(email) }] },
    select: { status: true, role: true },
  });
  if (seat?.status === "ACTIVE") {
    throw new AppError(409, `You are already an active member of ${startup.name}.`, "ALREADY_MEMBER");
  }
  if (seat?.status === "INVITED") {
    throw new AppError(
      409,
      `${startup.name} has already invited you. Use the invitation link in your email.`,
      "INVITE_PENDING"
    );
  }

  const existing = await prisma.startupJoinRequest.findUnique({
    where: { userId_startupId: { userId, startupId: startup.id } },
  });
  if (existing && OPEN_STATUSES.includes(existing.status)) {
    throw new AppError(
      409,
      existing.status === "NEEDS_INFO"
        ? `${startup.name} asked you for more information. Update your existing request instead.`
        : `Your request to join ${startup.name} is already waiting for approval.`,
      "REQUEST_EXISTS"
    );
  }

  const fields = requestFields(input.kind, input, user.profile?.name || email.split("@")[0]);
  const data = {
    ...fields,
    kind: input.kind,
    email,
    status: "PENDING" as const,
    reviewNote: null,
    reviewedById: null,
    reviewedAt: null,
    employeeId: null,
    internId: null,
    submittedAt: new Date(),
  };

  let request;
  try {
    request = existing
      // Re-asking after a rejection, a withdrawal, or a deactivation reuses the
      // row; the earlier decision is already in the audit log.
      ? await prisma.startupJoinRequest.update({ where: { id: existing.id }, data })
      : await prisma.startupJoinRequest.create({ data: { ...data, userId, startupId: startup.id } });
  } catch (err) {
    // Two submissions racing: the unique index lets exactly one through.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError(409, `Your request to join ${startup.name} is already waiting for approval.`, "REQUEST_EXISTS");
    }
    throw err;
  }

  await audit({
    action: existing ? "affiliation.resubmitted" : "affiliation.requested",
    entity: "StartupJoinRequest",
    entityId: request.id,
    actorId: userId,
    startupId: startup.id,
    metadata: { kind: input.kind, previousStatus: existing?.status ?? null },
  });

  await notifyTenantRoles(startup.id, REVIEWER_ROLES, {
    event: "APPLICATION_RECEIVED",
    title: `New ${input.kind === "INTERN" ? "intern" : "employee"} request`,
    message: `${request.fullName} asked to join ${startup.name} as ${input.kind === "INTERN" ? "an intern" : "an employee"}.`,
    link: `/s/${startup.code}/requests`,
    channel: "inapp",
  }).catch((err) => logger.warn(`affiliation: reviewer notification failed: ${err.message}`));

  return request;
}

/** Edit an open request — how someone answers "please send more information". */
export async function updateRequest(userId: string, requestId: string, input: Partial<RequestInput>) {
  const existing = await prisma.startupJoinRequest.findFirst({
    where: { id: requestId, userId },
    include: { startup: { select: { name: true, code: true } } },
  });
  if (!existing) throw new AppError(404, "Request not found", "NOT_FOUND");
  if (!OPEN_STATUSES.includes(existing.status)) {
    throw new AppError(409, "This request has already been decided and can no longer be edited.", "REQUEST_CLOSED");
  }

  const kind = input.kind ?? existing.kind;
  const fields = requestFields(kind, { ...existing, joiningDate: existing.joiningDate?.toISOString(), endDate: existing.endDate?.toISOString(), ...input } as Partial<RequestInput>, existing.fullName);

  const updated = await prisma.startupJoinRequest.update({
    where: { id: existing.id },
    data: { ...fields, kind, status: "PENDING", submittedAt: new Date() },
  });

  await audit({
    action: "affiliation.updated",
    entity: "StartupJoinRequest",
    entityId: existing.id,
    actorId: userId,
    startupId: existing.startupId,
    metadata: { previousStatus: existing.status },
  });

  if (existing.status === "NEEDS_INFO") {
    await notifyTenantRoles(existing.startupId, REVIEWER_ROLES, {
      event: "APPLICATION_RECEIVED",
      title: "Request updated",
      message: `${updated.fullName} updated their request to join ${existing.startup.name}.`,
      link: `/s/${existing.startup.code}/requests`,
      channel: "inapp",
    }).catch(() => undefined);
  }

  return updated;
}

export async function cancelRequest(userId: string, requestId: string) {
  const existing = await prisma.startupJoinRequest.findFirst({ where: { id: requestId, userId } });
  if (!existing) throw new AppError(404, "Request not found", "NOT_FOUND");
  const res = await prisma.startupJoinRequest.updateMany({
    where: { id: existing.id, status: { in: OPEN_STATUSES } },
    data: { status: "CANCELLED" },
  });
  if (res.count !== 1) throw new AppError(409, "Only a request that is still waiting can be withdrawn.", "REQUEST_CLOSED");

  await audit({
    action: "affiliation.cancelled",
    entity: "StartupJoinRequest",
    entityId: existing.id,
    actorId: userId,
    startupId: existing.startupId,
  });
  return { cancelled: true };
}

/**
 * The employment records this person may see on their own dashboard.
 * A record whose access was deactivated is excluded even if its own status
 * says otherwise — access is decided by both.
 */
export async function myEmployment(userId: string, code?: string) {
  const startupFilter = code
    ? { startup: { code: code.toUpperCase(), isActive: true } }
    : { startup: { isActive: true } };

  const [employees, interns, deactivated] = await Promise.all([
    prisma.employee.findMany({
      where: { userId, status: { in: [...PERSON_ACTIVE] }, ...startupFilter },
      include: { startup: { select: { id: true, name: true, code: true, logoUrl: true, tagline: true, domain: true } } },
    }),
    prisma.intern.findMany({
      where: { userId, status: { in: [...PERSON_ACTIVE] }, ...startupFilter },
      include: { startup: { select: { id: true, name: true, code: true, logoUrl: true, tagline: true, domain: true } } },
    }),
    prisma.startupMember.findMany({
      where: { userId, status: "DEACTIVATED", role: { in: [...SELF_SERVICE_ROLES] } },
      select: { startupId: true },
    }),
  ]);
  const blocked = new Set(deactivated.map((d) => d.startupId));

  const supervisorIds = [
    ...employees.map((e) => e.managerId),
    ...interns.map((i) => i.mentorId),
  ].filter(Boolean) as string[];
  const supervisors = supervisorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: supervisorIds } },
        select: { id: true, profile: { select: { name: true } } },
      })
    : [];
  const supervisorName = (id: string | null) =>
    id ? supervisors.find((s) => s.id === id)?.profile?.name ?? null : null;

  return [
    ...employees.filter((e) => !blocked.has(e.startupId)).map((e) => ({
      kind: "EMPLOYEE" as const,
      personId: e.id,
      code: e.employeeCode,
      fullName: e.fullName,
      designation: e.designation,
      department: e.department,
      employmentType: e.employmentType,
      status: e.status,
      startDate: e.joinedAt,
      endDate: null,
      college: null,
      supervisor: supervisorName(e.managerId),
      onboardingCompletedAt: e.onboardingCompletedAt,
      startup: e.startup,
    })),
    ...interns.filter((i) => !blocked.has(i.startupId)).map((i) => ({
      kind: "INTERN" as const,
      personId: i.id,
      code: i.internCode,
      fullName: i.fullName,
      designation: i.designation,
      department: i.department,
      employmentType: "INTERNSHIP",
      status: i.status,
      startDate: i.startDate,
      endDate: i.endDate,
      college: i.college,
      supervisor: supervisorName(i.mentorId),
      onboardingCompletedAt: i.onboardingCompletedAt,
      startup: i.startup,
    })),
  ];
}

/**
 * For self-service routes acting on one HR record: the record must belong to
 * the caller, be current, and its access must not have been withdrawn.
 */
export async function assertSelfService(userId: string, startupId: string) {
  const deactivated = await prisma.startupMember.findFirst({
    where: { userId, startupId, status: "DEACTIVATED", role: { in: [...SELF_SERVICE_ROLES] } },
    select: { id: true },
  });
  if (deactivated) {
    throw new AppError(403, "Your access to this startup has been deactivated.", "ACCESS_DEACTIVATED");
  }
}

// ─── What a startup admin sees ──────────────────────────────────────────

const requestUserSelect = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  avatarUrl: true,
  profile: {
    select: {
      name: true, phone: true, college: true, degree: true, branch: true, graduationYear: true,
      city: true, linkedinUrl: true, githubUrl: true, portfolioUrl: true, skills: true,
    },
  },
} as const;

export async function tenantSummary(startupId: string) {
  const [byStatus, employees, interns, deactivated] = await Promise.all([
    prisma.startupJoinRequest.groupBy({ by: ["status"], where: { startupId }, _count: { _all: true } }),
    prisma.employee.count({ where: { startupId, status: { in: [...PERSON_ACTIVE] } } }),
    prisma.intern.count({ where: { startupId, status: { in: [...PERSON_ACTIVE] } } }),
    prisma.startupMember.count({ where: { startupId, status: "DEACTIVATED" } }),
  ]);
  const n = (s: JoinRequestStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  return {
    pending: n("PENDING"),
    needsInfo: n("NEEDS_INFO"),
    approved: n("APPROVED"),
    rejected: n("REJECTED"),
    activeEmployees: employees,
    activeInterns: interns,
    deactivated,
  };
}

export async function listRequests(startupId: string, status?: string) {
  const where: Prisma.StartupJoinRequestWhereInput = { startupId };
  if (status === "OPEN") where.status = { in: OPEN_STATUSES };
  else if (status && status !== "ALL") {
    if (!Object.values(JoinRequestStatus).includes(status as JoinRequestStatus)) {
      throw new AppError(400, "Unknown status filter", "INVALID_FILTER");
    }
    where.status = status as JoinRequestStatus;
  } else if (!status) where.status = { not: "CANCELLED" };

  const [items, summary] = await Promise.all([
    prisma.startupJoinRequest.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      take: 500,
      include: {
        user: { select: { id: true, email: true, emailVerifiedAt: true, avatarUrl: true } },
        reviewedBy: { select: { id: true, profile: { select: { name: true } } } },
      },
    }),
    tenantSummary(startupId),
  ]);

  return {
    summary,
    items: items.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      fullName: r.fullName,
      email: r.email,
      emailVerified: Boolean(r.user.emailVerifiedAt),
      avatarUrl: r.user.avatarUrl,
      designation: r.designation,
      department: r.department,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      reviewedBy: r.reviewedBy?.profile?.name ?? null,
      reviewNote: r.reviewNote,
      personId: r.employeeId ?? r.internId,
      offerStatus: r.offerStatus,
      offerError: r.offerError,
    })),
  };
}

/**
 * Platform admin view: join requests across every startup, newest first.
 * Same filters as a startup's own list, plus an optional startup code.
 */
export async function listAllRequests(opts: { status?: string; startupCode?: string }) {
  const where: Prisma.StartupJoinRequestWhereInput = {};
  const { status, startupCode } = opts;
  if (status === "OPEN") where.status = { in: OPEN_STATUSES };
  else if (status && status !== "ALL") {
    if (!Object.values(JoinRequestStatus).includes(status as JoinRequestStatus)) {
      throw new AppError(400, "Unknown status filter", "INVALID_FILTER");
    }
    where.status = status as JoinRequestStatus;
  } else if (!status) where.status = { not: "CANCELLED" };
  if (startupCode) where.startup = { code: startupCode.toUpperCase() };

  const [items, counts] = await Promise.all([
    prisma.startupJoinRequest.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      take: 500,
      include: {
        user: { select: { emailVerifiedAt: true, avatarUrl: true } },
        reviewedBy: { select: { profile: { select: { name: true } } } },
        startup: { select: { id: true, name: true, code: true, logoUrl: true } },
      },
    }),
    prisma.startupJoinRequest.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<JoinRequestStatus, number>>,
    items: items.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      fullName: r.fullName,
      email: r.email,
      emailVerified: Boolean(r.user.emailVerifiedAt),
      avatarUrl: r.user.avatarUrl,
      designation: r.designation,
      department: r.department,
      college: r.college,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      reviewedBy: r.reviewedBy?.profile?.name ?? null,
      reviewNote: r.reviewNote,
      offerStatus: r.offerStatus,
      offerError: r.offerError,
      startup: r.startup,
    })),
  };
}

/** Which startup a request belongs to — how platform-admin actions find their tenant. */
export async function requestStartup(requestId: string) {
  const r = await prisma.startupJoinRequest.findUnique({
    where: { id: requestId },
    select: { startup: { select: { id: true, name: true, code: true, logoUrl: true } } },
  });
  if (!r) throw new AppError(404, "Request not found", "NOT_FOUND");
  return r.startup;
}

export async function getRequest(startupId: string, requestId: string) {
  const r = await prisma.startupJoinRequest.findFirst({
    where: { id: requestId, startupId },
    include: {
      user: { select: requestUserSelect },
      reviewedBy: { select: { id: true, profile: { select: { name: true } } } },
      employee: { select: { id: true, employeeCode: true, status: true } },
      intern: { select: { id: true, internCode: true, status: true } },
      offerDocument: { select: { documentNo: true, issuedAt: true, revokedAt: true } },
    },
  });
  if (!r) throw new AppError(404, "Request not found", "NOT_FOUND");

  // Who the reviewer can assign as supervisor: active people in this startup only.
  const supervisorSeats = await prisma.startupMember.findMany({
    where: { startupId, status: "ACTIVE", userId: { not: null }, role: { in: [...STAFF_ROLES, "EMPLOYEE"] as never[] } },
    select: { userId: true, role: true, user: { select: { profile: { select: { name: true } } } } },
    orderBy: { createdAt: "asc" },
  });

  const events = await prisma.auditLog.findMany({
    where: { entity: "StartupJoinRequest", entityId: r.id },
    orderBy: { createdAt: "asc" },
    select: { action: true, adminId: true, createdAt: true, metadata: true },
  });
  const actorIds = [...new Set(events.map((e) => e.adminId).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, profile: { select: { name: true } } } })
    : [];

  const person = r.employee
    ? { id: r.employee.id, kind: "EMPLOYEE", code: r.employee.employeeCode, status: r.employee.status }
    : r.intern
      ? { id: r.intern.id, kind: "INTERN", code: r.intern.internCode, status: r.intern.status }
      : null;

  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    fullName: r.fullName,
    email: r.email,
    phone: r.phone,
    department: r.department,
    designation: r.designation,
    college: r.college,
    joiningDate: r.joiningDate,
    endDate: r.endDate,
    note: r.note,
    reviewNote: r.reviewNote,
    submittedAt: r.submittedAt,
    reviewedAt: r.reviewedAt,
    reviewedBy: r.reviewedBy?.profile?.name ?? null,
    user: {
      id: r.user.id,
      email: r.user.email,
      emailVerified: Boolean(r.user.emailVerifiedAt),
      avatarUrl: r.user.avatarUrl,
      profile: r.user.profile,
    },
    person,
    offer: r.offerStatus || r.offerDocument
      ? {
          status: r.offerStatus,
          documentNo: r.offerDocument?.documentNo ?? null,
          issuedAt: r.offerDocument?.issuedAt ?? null,
          revoked: Boolean(r.offerDocument?.revokedAt),
          error: r.offerError,
          message: offerReasonText(r.offerError),
          attempts: r.offerAttempts,
          sentAt: r.offerSentAt,
        }
      : null,
    supervisors: supervisorSeats.map((m) => ({ userId: m.userId, role: m.role, name: m.user?.profile?.name ?? "Unnamed" })),
    history: events.map((e) => {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      return {
        action: e.action,
        at: e.createdAt,
        by: actors.find((a) => a.id === e.adminId)?.profile?.name ?? null,
        note: (meta.reason ?? meta.message ?? null) as string | null,
      };
    }),
  };
}

export interface ApproveInput {
  startupId: string;
  startupCode: string;
  requestId: string;
  actorId: string;
  designation?: string;
  department?: string;
  joiningDate?: string;
  endDate?: string;
  supervisorUserId?: string;
  /** Email the offer letter. Defaults to true for interns, false for employees
   *  (the same default a direct hire has). */
  issueOfferLetter?: boolean;
  /** Printed on the letter. Stipend for interns, CTC for employees. */
  stipend?: string;
  ctc?: string;
  workMode?: "OFFICE" | "REMOTE" | "HYBRID";
  location?: string;
}

/**
 * Approve and activate, in one transaction:
 *   1. claim the request (PENDING/NEEDS_INFO → APPROVED; a concurrent second
 *      approval finds nothing to claim)
 *   2. create the Employee/Intern record, or reuse the one HR already has
 *   3. activate the StartupMember seat at EMPLOYEE/INTERN level
 *   4. link the request to the record and audit it
 * Approving an already-approved request changes nothing and returns it.
 */
export async function approveRequest(input: ApproveInput) {
  const now = new Date();

  const outcome = await prisma.$transaction(async (tx) => {
    const req = await tx.startupJoinRequest.findFirst({
      where: { id: input.requestId, startupId: input.startupId },
      include: { user: { select: { id: true, email: true, emailVerifiedAt: true } } },
    });
    if (!req) throw new AppError(404, "Request not found", "NOT_FOUND");
    if (req.status === "APPROVED") return { req, alreadyApproved: true as const };
    if (!OPEN_STATUSES.includes(req.status)) {
      throw new AppError(409, `This request was ${req.status.toLowerCase()} and cannot be approved.`, "REQUEST_CLOSED");
    }
    if (!req.user.emailVerifiedAt) {
      throw new AppError(409, "The requester has not verified their email address yet.", "EMAIL_NOT_VERIFIED");
    }

    const claimed = await tx.startupJoinRequest.updateMany({
      where: { id: req.id, status: { in: OPEN_STATUSES } },
      data: { status: "APPROVED", reviewedById: input.actorId, reviewedAt: now, reviewNote: null },
    });
    if (claimed.count !== 1) throw new AppError(409, "This request was just reviewed by someone else.", "REQUEST_CLOSED");

    const isIntern = req.kind === "INTERN";
    const email = req.user.email.trim().toLowerCase();

    const seat = await tx.startupMember.findFirst({
      where: { startupId: input.startupId, OR: [{ userId: req.userId }, { email: insensitive(email) }] },
    });
    if (seat && STAFF_ROLES.includes(seat.role)) {
      // Never let an HR approval activate (or downgrade) a staff seat.
      throw new AppError(
        409,
        seat.status === "ACTIVE"
          ? "This person is already on the startup's staff."
          : "This person has a pending staff invitation. Resolve that first.",
        "STAFF_SEAT_EXISTS"
      );
    }

    let supervisorId: string | null = null;
    if (input.supervisorUserId) {
      const sup = await tx.startupMember.findFirst({
        where: { startupId: input.startupId, userId: input.supervisorUserId, status: "ACTIVE" },
        select: { userId: true },
      });
      if (!sup) throw new AppError(400, "The supervisor must be an active member of this startup.", "INVALID_SUPERVISOR");
      supervisorId = sup.userId;
    }

    const designation =
      trimOrNull(input.designation, 120) ?? req.designation ?? (isIntern ? "Intern" : "Team Member");
    const department = trimOrNull(input.department, 120) ?? req.department;
    const start = parseDate(input.joiningDate, "joining date") ?? req.joiningDate ?? now;
    const stipend = trimOrNull(input.stipend, 120);
    const ctc = trimOrNull(input.ctc, 120);
    const sendLetter = input.issueOfferLetter ?? isIntern;

    // A *current* record of the other kind is a conflict, not something to
    // merge. A past one (an internship that ended) does not block a new role.
    const current = { startupId: input.startupId, email: insensitive(email), status: { in: [...PERSON_ACTIVE] } };
    const otherKind = isIntern
      ? await tx.employee.findFirst({ where: current, select: { id: true } })
      : await tx.intern.findFirst({ where: current, select: { id: true } });
    if (otherKind) {
      throw new AppError(
        409,
        `This person already has an ${isIntern ? "employee" : "intern"} record at this startup.`,
        "OTHER_RECORD_EXISTS"
      );
    }

    let personId: string;
    let code: string;

    if (isIntern) {
      let end = parseDate(input.endDate, "end date") ?? req.endDate;
      if (!end) {
        end = new Date(start);
        end.setMonth(end.getMonth() + 6);
      }
      if (end <= start) throw new AppError(400, "The internship end date must be after the start date", "INVALID_DATE");

      const existing = await tx.intern.findFirst({ where: { startupId: input.startupId, email: insensitive(email) } });
      if (existing?.userId && existing.userId !== req.userId) {
        throw new AppError(409, "An intern record with this email is linked to another account.", "RECORD_LINKED_ELSEWHERE");
      }
      const record = existing
        ? await tx.intern.update({
            where: { id: existing.id },
            data: {
              userId: req.userId, status: "ACTIVE", designation, department,
              ...(supervisorId ? { mentorId: supervisorId } : {}),
              ...(stipend ? { stipend } : {}),
            },
          })
        : await tx.intern.create({
            data: {
              startupId: input.startupId,
              internCode: await nextInternCode(tx, input.startupId, input.startupCode),
              userId: req.userId,
              fullName: req.fullName,
              email,
              phone: req.phone,
              college: req.college,
              department,
              designation,
              mentorId: supervisorId,
              stipend,
              startDate: start,
              endDate: end,
            },
          });
      personId = record.id;
      code = record.internCode;
    } else {
      const existing = await tx.employee.findFirst({ where: { startupId: input.startupId, email: insensitive(email) } });
      if (existing?.userId && existing.userId !== req.userId) {
        throw new AppError(409, "An employee record with this email is linked to another account.", "RECORD_LINKED_ELSEWHERE");
      }
      const record = existing
        ? await tx.employee.update({
            where: { id: existing.id },
            data: {
              userId: req.userId, status: "ACTIVE", exitedAt: null, designation, department,
              ...(supervisorId ? { managerId: supervisorId } : {}),
              ...(ctc ? { ctc } : {}),
            },
          })
        : await tx.employee.create({
            data: {
              startupId: input.startupId,
              employeeCode: await nextEmployeeCode(tx, input.startupId, input.startupCode),
              userId: req.userId,
              fullName: req.fullName,
              email,
              phone: req.phone,
              department,
              designation,
              employmentType: "FULL_TIME",
              joinedAt: start,
              managerId: supervisorId,
              ctc,
            },
          });
      personId = record.id;
      code = record.employeeCode;
    }

    const role = roleFor(req.kind);
    if (seat) {
      await tx.startupMember.update({
        where: { id: seat.id },
        data: { userId: req.userId, role, status: "ACTIVE", joinedAt: seat.joinedAt ?? now, deactivatedAt: null },
      });
    } else {
      await tx.startupMember.create({
        data: {
          startupId: input.startupId,
          userId: req.userId,
          email,
          role,
          status: "ACTIVE",
          invitedBy: input.actorId,
          // Required and unique, but nobody needs to redeem it: access was granted by approval.
          inviteToken: hashedToken(),
          joinedAt: now,
        },
      });
    }

    await tx.startupJoinRequest.update({
      where: { id: req.id },
      data: {
        ...(isIntern ? { internId: personId, employeeId: null } : { employeeId: personId, internId: null }),
        // Claimed here, inside the approval, so exactly one sender ever owns
        // this letter; the email itself goes out after the commit.
        ...(sendLetter
          ? {
              offerStatus: "SENDING" as const,
              offerTerms: { workMode: input.workMode ?? "OFFICE", location: trimOrNull(input.location, 200) } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    await audit(
      {
        action: "affiliation.approved",
        entity: "StartupJoinRequest",
        entityId: req.id,
        actorId: input.actorId,
        startupId: input.startupId,
        metadata: { kind: req.kind, personId, code, designation },
      },
      tx
    );

    return { req, alreadyApproved: false as const, personId, code, designation, sendLetter };
  });

  if (outcome.alreadyApproved) {
    return { requestId: outcome.req.id, status: "APPROVED", alreadyApproved: true, personId: outcome.req.employeeId ?? outcome.req.internId };
  }

  const startup = await prisma.startup.findUnique({
    where: { id: input.startupId },
    select: { name: true, logoUrl: true, code: true },
  });
  // The membership is committed. The letter is a separate, external step: a
  // failure is recorded on the request (and reported to the admin) but never
  // undoes the approval. deliverOfferLetter does not throw.
  let offer: (OfferResult & { message: string | null }) | null = null;
  if (outcome.sendLetter) {
    const r = await deliverOfferLetter(outcome.req.id, input.actorId);
    offer = { ...r, message: offerReasonText(r.error) };
  }

  await notify({
    userId: outcome.req.userId,
    event: "JOINED",
    // With an offer letter, that email is the welcome; no second mail.
    channel: outcome.sendLetter ? "inapp" : "all",
    title: `You're in — ${startup?.name}`,
    message: `${startup?.name} approved your ${outcome.req.kind === "INTERN" ? "internship" : "employment"}. Your ID is ${outcome.code}.`,
    link: destinationFor(startup?.code ?? input.startupCode, roleFor(outcome.req.kind)),
    html: Emails.joined({
      name: outcome.req.fullName,
      startupName: startup?.name ?? "the team",
      employeeCode: outcome.code,
      designation: outcome.designation,
      logoUrl: startup?.logoUrl,
    }),
  }).catch((err) => logger.warn(`affiliation: approval notification failed: ${err.message}`));

  return {
    requestId: outcome.req.id,
    status: "APPROVED",
    alreadyApproved: false,
    personId: outcome.personId,
    code: outcome.code,
    kind: outcome.req.kind,
    offer,
  };
}

async function decide(args: {
  startupId: string;
  requestId: string;
  actorId: string;
  to: "REJECTED" | "NEEDS_INFO";
  note: string;
}) {
  const req = await prisma.startupJoinRequest.findFirst({
    where: { id: args.requestId, startupId: args.startupId },
    include: { startup: { select: { name: true } } },
  });
  if (!req) throw new AppError(404, "Request not found", "NOT_FOUND");

  const res = await prisma.startupJoinRequest.updateMany({
    where: { id: req.id, status: { in: OPEN_STATUSES } },
    data: { status: args.to, reviewNote: args.note, reviewedById: args.actorId, reviewedAt: new Date() },
  });
  if (res.count !== 1) {
    throw new AppError(409, `This request was ${req.status.toLowerCase()} and cannot be changed now.`, "REQUEST_CLOSED");
  }

  await audit({
    action: args.to === "REJECTED" ? "affiliation.rejected" : "affiliation.info_requested",
    entity: "StartupJoinRequest",
    entityId: req.id,
    actorId: args.actorId,
    startupId: args.startupId,
    metadata: args.to === "REJECTED" ? { reason: args.note } : { message: args.note },
  });

  await notify({
    userId: req.userId,
    event: args.to === "REJECTED" ? "REJECTED" : "STAGE_CHANGED",
    title: args.to === "REJECTED"
      ? `Your request to join ${req.startup.name} was not approved`
      : `${req.startup.name} needs more information`,
    message: args.note,
    link: "/workspace",
  }).catch((err) => logger.warn(`affiliation: decision notification failed: ${err.message}`));

  return { requestId: req.id, status: args.to };
}

export const rejectRequest = (a: { startupId: string; requestId: string; actorId: string; reason: string }) =>
  decide({ ...a, to: "REJECTED", note: a.reason });

export const requestMoreInfo = (a: { startupId: string; requestId: string; actorId: string; message: string }) =>
  decide({ ...a, to: "NEEDS_INFO", note: a.message });

// ─── Team members: active / deactivated ─────────────────────────────────

async function resolvePerson(startupId: string, personId: string) {
  const employee = await prisma.employee.findFirst({ where: { id: personId, startupId } });
  if (employee) return { kind: "EMPLOYEE" as const, employee, intern: null, person: employee };
  const intern = await prisma.intern.findFirst({ where: { id: personId, startupId } });
  if (intern) return { kind: "INTERN" as const, employee: null, intern, person: intern };
  throw new AppError(404, "Person not found in this startup", "NOT_FOUND");
}

/** Employees and interns with their access state, for the admin's team tabs. */
export async function listAffiliates(startupId: string) {
  const [employees, interns, seats] = await Promise.all([
    prisma.employee.findMany({ where: { startupId }, orderBy: { joinedAt: "desc" } }),
    prisma.intern.findMany({ where: { startupId }, orderBy: { startDate: "desc" } }),
    prisma.startupMember.findMany({
      where: { startupId, role: { in: [...SELF_SERVICE_ROLES] } },
      select: { email: true, userId: true, status: true, deactivatedAt: true },
    }),
  ]);
  const seatFor = (p: { email: string; userId: string | null }) =>
    seats.find((s) => (p.userId && s.userId === p.userId) || s.email.toLowerCase() === p.email.toLowerCase());

  const row = (kind: "EMPLOYEE" | "INTERN", p: any) => {
    const seat = seatFor(p);
    return {
      id: p.id,
      kind,
      code: kind === "EMPLOYEE" ? p.employeeCode : p.internCode,
      fullName: p.fullName,
      email: p.email,
      designation: p.designation,
      department: p.department,
      status: p.status,
      access: seat?.status ?? (p.userId ? "ACTIVE" : "NO_ACCOUNT"),
      hasAccount: Boolean(p.userId),
      startDate: kind === "EMPLOYEE" ? p.joinedAt : p.startDate,
      endDate: kind === "INTERN" ? p.endDate : null,
      deactivatedAt: seat?.deactivatedAt ?? null,
    };
  };

  return [...employees.map((e) => row("EMPLOYEE", e)), ...interns.map((i) => row("INTERN", i))];
}

/**
 * Withdraw someone's access without deleting their history. Their record is
 * marked EXITED and their EMPLOYEE/INTERN seat DEACTIVATED, which every
 * workspace and self-service check reads on the very next request.
 * A staff seat (ADMIN, HR …) held by the same person is never touched here.
 */
export async function deactivatePerson(args: { startupId: string; personId: string; actorId: string; reason?: string }) {
  const { kind, person, employee } = await resolvePerson(args.startupId, args.personId);
  const now = new Date();

  const seat = await prisma.startupMember.findFirst({
    where: {
      startupId: args.startupId,
      role: { in: [...SELF_SERVICE_ROLES] },
      OR: [...(person.userId ? [{ userId: person.userId }] : []), { email: insensitive(person.email) }],
    },
  });
  if (seat?.status === "DEACTIVATED") throw new AppError(409, "This person is already deactivated.", "ALREADY_DEACTIVATED");

  await prisma.$transaction(async (tx) => {
    if (employee) {
      await tx.employee.update({ where: { id: person.id }, data: { status: "EXITED", exitedAt: employee.exitedAt ?? now } });
    } else {
      await tx.intern.update({ where: { id: person.id }, data: { status: "EXITED" } });
    }
    if (seat) {
      await tx.startupMember.update({ where: { id: seat.id }, data: { status: "DEACTIVATED", deactivatedAt: now } });
    } else {
      // No seat yet (e.g. never signed up): record one so the state is explicit
      // and a later sign-up cannot quietly activate it.
      await tx.startupMember.create({
        data: {
          startupId: args.startupId,
          userId: person.userId,
          email: person.email.toLowerCase(),
          role: kind,
          status: "DEACTIVATED",
          invitedBy: args.actorId,
          inviteToken: hashedToken(),
          deactivatedAt: now,
        },
      });
    }
    await audit(
      {
        action: "affiliation.deactivated",
        entity: kind === "EMPLOYEE" ? "Employee" : "Intern",
        entityId: person.id,
        actorId: args.actorId,
        startupId: args.startupId,
        metadata: { reason: trimOrNull(args.reason, 1000), email: person.email },
      },
      tx
    );
  });

  if (person.userId) {
    await notify({
      userId: person.userId,
      event: "STAGE_CHANGED",
      title: "Your startup access has changed",
      message: "Your access to this startup's workspace has been deactivated by an administrator.",
      link: "/workspace",
      channel: "inapp",
    }).catch(() => undefined);
  }

  return { personId: person.id, access: "DEACTIVATED" };
}

export async function reactivatePerson(args: { startupId: string; personId: string; actorId: string }) {
  const { kind, person } = await resolvePerson(args.startupId, args.personId);

  const seat = await prisma.startupMember.findFirst({
    where: {
      startupId: args.startupId,
      role: { in: [...SELF_SERVICE_ROLES] },
      status: "DEACTIVATED",
      OR: [...(person.userId ? [{ userId: person.userId }] : []), { email: insensitive(person.email) }],
    },
  });
  if (!seat) {
    throw new AppError(409, "Only someone deactivated here can be reactivated.", "NOT_DEACTIVATED");
  }

  await prisma.$transaction(async (tx) => {
    if (kind === "EMPLOYEE") {
      await tx.employee.update({ where: { id: person.id }, data: { status: "ACTIVE", exitedAt: null } });
    } else {
      await tx.intern.update({ where: { id: person.id }, data: { status: "ACTIVE" } });
    }
    await tx.startupMember.update({
      where: { id: seat.id },
      // A person without an account stays INVITED until they sign up and verify.
      data: { status: seat.userId ? "ACTIVE" : "INVITED", deactivatedAt: null, joinedAt: seat.joinedAt ?? new Date() },
    });
    await audit(
      {
        action: "affiliation.reactivated",
        entity: kind === "EMPLOYEE" ? "Employee" : "Intern",
        entityId: person.id,
        actorId: args.actorId,
        startupId: args.startupId,
      },
      tx
    );
  });

  if (person.userId) {
    await notify({
      userId: person.userId,
      event: "JOINED",
      title: "Your startup access is back",
      message: "An administrator reactivated your access.",
      link: "/workspace",
      channel: "inapp",
    }).catch(() => undefined);
  }

  return { personId: person.id, access: seat.userId ? "ACTIVE" : "INVITED" };
}

// ─── Platform admin overview ────────────────────────────────────────────

export async function platformOverview() {
  const [startups, employees, interns, open, active, deactivated] = await Promise.all([
    prisma.startup.findMany({
      select: { id: true, name: true, code: true, logoUrl: true, isActive: true, isVerified: true, type: true },
      orderBy: { name: "asc" },
    }),
    prisma.employee.groupBy({ by: ["startupId"], where: { status: { in: [...PERSON_ACTIVE] } }, _count: { _all: true } }),
    prisma.intern.groupBy({ by: ["startupId"], where: { status: { in: [...PERSON_ACTIVE] } }, _count: { _all: true } }),
    prisma.startupJoinRequest.groupBy({ by: ["startupId"], where: { status: { in: OPEN_STATUSES } }, _count: { _all: true } }),
    prisma.startupMember.groupBy({ by: ["startupId"], where: { status: "ACTIVE" }, _count: { _all: true } }),
    prisma.startupMember.groupBy({ by: ["startupId"], where: { status: "DEACTIVATED" }, _count: { _all: true } }),
  ]);
  const count = (rows: Array<{ startupId: string; _count: { _all: number } }>, id: string) =>
    rows.find((r) => r.startupId === id)?._count._all ?? 0;

  const items = startups.map((s) => ({
    ...s,
    employees: count(employees, s.id),
    interns: count(interns, s.id),
    pending: count(open, s.id),
    activeMembers: count(active, s.id),
    deactivated: count(deactivated, s.id),
  }));

  return {
    items,
    totals: items.reduce(
      (t, i) => ({
        employees: t.employees + i.employees,
        interns: t.interns + i.interns,
        pending: t.pending + i.pending,
        activeMembers: t.activeMembers + i.activeMembers,
      }),
      { employees: 0, interns: 0, pending: 0, activeMembers: 0 }
    ),
  };
}
