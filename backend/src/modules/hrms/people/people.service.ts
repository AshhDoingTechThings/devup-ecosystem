import { prisma } from "../../../lib/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { audit } from "../../shared/audit.service";
import { getChecklist } from "../onboarding/onboarding.service";
import { fileLink } from "../documents/documentFiles";
import { LETTER_FIELDS, regenerateOfferLetter, STALE_SENDING_MS } from "../../affiliations/offerLetter.service";

/** The offer letter from their join request, if one was issued. */
async function letterRequest(startupId: string, personId: string) {
  return prisma.startupJoinRequest.findFirst({
    where: { startupId, status: "APPROVED", offerDocumentId: { not: null }, OR: [{ internId: personId }, { employeeId: personId }] },
    orderBy: { reviewedAt: "desc" },
    select: {
      id: true, offerStatus: true, offerSentAt: true, offerError: true, offerTerms: true, updatedAt: true,
      offerDocument: { select: { documentNo: true } },
    },
  });
}

/**
 * Everything about one person in a startup: their record, their onboarding
 * documents, and the documents the company has issued them.
 */

async function resolve(startupId: string, personId: string) {
  const employee = await prisma.employee.findFirst({
    where: { id: personId, startupId },
    include: {
      documents: { orderBy: { issuedAt: "desc" } },
      application: {
        select: {
          id: true, applicationNo: true, appliedAt: true,
          job: { select: { title: true } },
        },
      },
      user: { select: { id: true, email: true, avatarUrl: true } },
    },
  });
  if (employee) return { kind: "EMPLOYEE" as const, employee, intern: null };

  const intern = await prisma.intern.findFirst({
    where: { id: personId, startupId },
    include: {
      documents: { orderBy: { issuedAt: "desc" } },
      application: {
        select: {
          id: true, applicationNo: true, appliedAt: true,
          job: { select: { title: true } },
        },
      },
      user: { select: { id: true, email: true, avatarUrl: true } },
    },
  });
  if (intern) return { kind: "INTERN" as const, employee: null, intern };

  throw new AppError(404, "Person not found in this startup", "NOT_FOUND");
}

/**
 * `canSeeFiles`: links to uploaded ID scans and issued letters are HR+ only,
 * matching the onboarding and document routes. Managers see the person and
 * document statuses, but no file links.
 */
export async function getPerson(startupId: string, personId: string, opts: { canSeeFiles?: boolean } = {}) {
  const canSeeFiles = opts.canSeeFiles ?? true;
  const { kind, employee, intern } = await resolve(startupId, personId);
  const p: any = employee ?? intern;
  const fullChecklist = await getChecklist(startupId, personId);
  const checklist = canSeeFiles
    ? fullChecklist
    : { ...fullChecklist, items: fullChecklist.items.map((i: any) => ({ ...i, fileUrl: null })) };

  const offer = p.application
    ? await prisma.offerLetter.findUnique({
        where: { applicationId: p.application.id },
        select: { offerNo: true, status: true, joiningDate: true, expiresAt: true, designation: true },
      })
    : null;

  return {
    kind,
    id: p.id,
    code: employee?.employeeCode ?? intern?.internCode,
    fullName: p.fullName,
    email: p.email,
    phone: p.phone,
    designation: p.designation,
    department: p.department,
    status: p.status,
    isDirectHire: p.isDirectHire,
    onboardingCompletedAt: p.onboardingCompletedAt,
    hasAccount: Boolean(p.userId),
    avatarUrl: p.user?.avatarUrl ?? null,

    // Employee-only
    employmentType: employee?.employmentType ?? "INTERNSHIP",
    joinedAt: employee?.joinedAt ?? intern?.startDate,
    exitedAt: employee?.exitedAt ?? null,
    ctc: employee?.ctc ?? null,
    managerId: employee?.managerId ?? intern?.mentorId ?? null,

    // Intern-only
    college: intern?.college ?? null,
    stipend: intern?.stipend ?? null,
    stipendAmount: intern?.stipendAmount ?? null,
    endDate: intern?.endDate ?? null,

    /** Who can be picked as their mentor/manager when editing. */
    supervisors: await supervisorOptions(startupId),

    /** Their offer letter from the join request: what it is and whether it went out. */
    offerLetter: await letterRequest(startupId, personId).then((r) => {
      if (!r) return null;
      const terms = (r.offerTerms ?? {}) as { workMode?: string; location?: string };
      return {
        requestId: r.id,
        documentNo: r.offerDocument?.documentNo ?? null,
        /** READY = generated, not emailed yet. */
        status: r.offerStatus ?? "READY",
        stuck: r.offerStatus === "SENDING" && Date.now() - r.updatedAt.getTime() > STALE_SENDING_MS,
        sentAt: r.offerSentAt,
        workMode: terms.workMode ?? "OFFICE",
        location: terms.location ?? null,
      };
    }),

    /** Where they came from — null for a direct hire. */
    application: p.application
      ? {
          id: p.application.id,
          applicationNo: p.application.applicationNo,
          jobTitle: p.application.job?.title,
          appliedAt: p.application.appliedAt,
        }
      : null,
    offer,

    /** Papers they uploaded. */
    onboarding: checklist,

    /** Papers the company issued them. */
    issuedDocuments: await Promise.all(
      p.documents.map(async (d: any) => ({
        id: d.id,
        documentNo: d.documentNo,
        docType: d.docType,
        pdfUrl: canSeeFiles ? await fileLink(d) : null,
        issuedAt: d.issuedAt,
        revokedAt: d.revokedAt,
      }))
    ),
  };
}

/**
 * Removes someone from a startup.
 *
 * A person with issued documents is refused unless explicitly forced: an offer
 * letter or certificate already in someone's hands is a record that should not
 * silently vanish. Their uploaded documents and workspace access always go with
 * them — keeping identity papers for a deleted person would be wrong.
 */
export async function deletePerson(args: {
  startupId: string;
  personId: string;
  actorId: string;
  force?: boolean;
}) {
  const { kind, employee, intern } = await resolve(args.startupId, args.personId);
  const p: any = employee ?? intern;
  const code = employee?.employeeCode ?? intern?.internCode;

  const issued = p.documents.filter((d: any) => !d.revokedAt);
  if (issued.length > 0 && !args.force) {
    throw new AppError(
      409,
      `${p.fullName} has ${issued.length} issued document${issued.length === 1 ? "" : "s"} (${issued
        .map((d: any) => d.documentNo)
        .slice(0, 3)
        .join(", ")}). Deleting removes them permanently.`,
      "HAS_ISSUED_DOCUMENTS"
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.onboardingDocument.deleteMany({
      where: employee ? { employeeId: employee.id } : { internId: intern!.id },
    });

    if (employee) {
      await tx.attendance.deleteMany({ where: { employeeId: employee.id } });
      await tx.performanceReview.deleteMany({ where: { employeeId: employee.id } });
      await tx.hrDocument.deleteMany({ where: { employeeId: employee.id } });
      await tx.employee.delete({ where: { id: employee.id } });
    } else {
      await tx.hrDocument.deleteMany({ where: { internId: intern!.id } });
      await tx.intern.delete({ where: { id: intern!.id } });
    }

    // Revoke workspace access, but only the EMPLOYEE/INTERN membership — never
    // strip someone who is also an admin or founder of the same startup.
    await tx.startupMember.deleteMany({
      where: {
        startupId: args.startupId,
        email: p.email,
        role: { in: ["EMPLOYEE", "INTERN"] },
      },
    });
  });

  await audit({
    action: "hrms.person_deleted",
    entity: kind === "EMPLOYEE" ? "Employee" : "Intern",
    entityId: args.personId,
    actorId: args.actorId,
    startupId: args.startupId,
    metadata: { code, email: p.email, fullName: p.fullName, issuedDocuments: issued.length },
  });

  return { deleted: true, code, fullName: p.fullName };
}

export const SUPERVISOR_ROLES = ["OWNER", "FOUNDER", "ADMIN", "HR", "RECRUITER", "MANAGER", "EMPLOYEE"] as const;

/** Who can be someone's mentor or manager: active members of this startup with an account. */
export async function supervisorOptions(startupId: string) {
  const seats = await prisma.startupMember.findMany({
    where: { startupId, status: "ACTIVE", userId: { not: null }, role: { in: [...SUPERVISOR_ROLES] as never[] } },
    select: { userId: true, role: true, user: { select: { profile: { select: { name: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  // One entry per person, even if they hold two seats.
  const seen = new Set<string>();
  return seats
    .filter((s) => s.userId && !seen.has(s.userId) && seen.add(s.userId))
    .map((s) => ({ userId: s.userId as string, role: s.role, name: s.user?.profile?.name ?? "Unnamed" }));
}

export interface PersonEdit {
  fullName?: string;
  phone?: string | null;
  designation?: string;
  department?: string | null;
  supervisorUserId?: string | null;
  // Intern
  college?: string | null;
  stipend?: string | null;
  stipendAmount?: number | null;
  startDate?: string;
  endDate?: string;
  // Employee
  ctc?: string | null;
  employmentType?: "INTERNSHIP" | "FULL_TIME" | "PART_TIME" | "CONTRACT";
  joinedAt?: string;
  // Offer letter terms (kept on the join request; only when a letter exists)
  workMode?: "OFFICE" | "HYBRID" | "REMOTE";
  location?: string | null;
}

const LABELS: Record<string, string> = {
  fullName: "name", phone: "phone", designation: "designation", department: "department",
  college: "college", stipend: "stipend", stipendAmount: "monthly stipend", startDate: "start date",
  endDate: "end date", ctc: "CTC", employmentType: "employment type", joinedAt: "joining date",
  mentorId: "mentor", managerId: "manager", workMode: "work mode", location: "work location",
};

function dateOrThrow(v: string, field: string) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError(400, `Invalid ${field}`, "INVALID_DATE");
  return d;
}

/** "" means "clear it" for optional text; undefined means "leave it alone". */
const optText = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === "" ? null : v.trim());

/**
 * Edit a person's record. Email is not editable here: it is how their record,
 * workspace seat and DevUp account are matched, so changing it would detach
 * them. Access (active / deactivated) has its own actions.
 */
export async function updatePerson(args: {
  startupId: string;
  personId: string;
  actorId: string;
  data: PersonEdit;
}) {
  const { kind, employee, intern } = await resolve(args.startupId, args.personId);
  const d = args.data;
  const before: any = employee ?? intern;

  const data: Record<string, unknown> = {};
  if (d.fullName !== undefined) {
    if (!d.fullName.trim()) throw new AppError(400, "Name can't be empty", "VALIDATION_ERROR");
    data.fullName = d.fullName.trim();
  }
  if (d.designation !== undefined) {
    if (!d.designation.trim()) throw new AppError(400, "Designation can't be empty", "VALIDATION_ERROR");
    data.designation = d.designation.trim();
  }
  if (d.phone !== undefined) data.phone = optText(d.phone);
  if (d.department !== undefined) data.department = optText(d.department);

  if (d.supervisorUserId !== undefined) {
    let supervisor: string | null = null;
    if (d.supervisorUserId) {
      const ok = (await supervisorOptions(args.startupId)).some((s) => s.userId === d.supervisorUserId);
      if (!ok) throw new AppError(400, "The mentor or manager must be an active member of this startup.", "INVALID_SUPERVISOR");
      if (before.userId && before.userId === d.supervisorUserId) {
        throw new AppError(400, "Someone can't be their own mentor or manager.", "INVALID_SUPERVISOR");
      }
      supervisor = d.supervisorUserId;
    }
    data[employee ? "managerId" : "mentorId"] = supervisor;
  }

  if (employee) {
    if (d.ctc !== undefined) data.ctc = optText(d.ctc);
    if (d.employmentType !== undefined) data.employmentType = d.employmentType;
    if (d.joinedAt) data.joinedAt = dateOrThrow(d.joinedAt, "joining date");
  } else {
    if (d.college !== undefined) data.college = optText(d.college);
    if (d.stipend !== undefined) data.stipend = optText(d.stipend);
    if (d.stipendAmount !== undefined) data.stipendAmount = d.stipendAmount;
    if (d.startDate) data.startDate = dateOrThrow(d.startDate, "start date");
    if (d.endDate) data.endDate = dateOrThrow(d.endDate, "end date");
    const start = (data.startDate as Date | undefined) ?? intern!.startDate;
    const end = (data.endDate as Date | undefined) ?? intern!.endDate;
    if (end <= start) throw new AppError(400, "The end date must be after the start date.", "INVALID_DATE");
  }

  // Only what actually changed is written and recorded.
  const same = (a: unknown, b: unknown) =>
    a instanceof Date || b instanceof Date
      ? new Date(a as any).getTime() === new Date(b as any).getTime()
      : (a ?? null) === (b ?? null);
  const changed = Object.keys(data).filter((k) => !same(data[k], before[k]));

  // Work mode and location only exist on the offer letter's terms.
  let termsUpdate: { requestId: string; terms: Record<string, unknown> } | null = null;
  if (d.workMode !== undefined || d.location !== undefined) {
    const req = await letterRequest(args.startupId, args.personId);
    if (req) {
      const terms = { ...((req.offerTerms ?? {}) as Record<string, unknown>) };
      if (d.workMode !== undefined && d.workMode !== (terms.workMode ?? "OFFICE")) {
        terms.workMode = d.workMode;
        changed.push("workMode");
      }
      const loc = optText(d.location);
      if (loc !== undefined && loc !== (terms.location ?? null)) {
        terms.location = loc;
        changed.push("location");
      }
      if (changed.includes("workMode") || changed.includes("location")) termsUpdate = { requestId: req.id, terms };
    }
  }
  if (changed.length === 0) return { ...(await getPerson(args.startupId, args.personId)), letter: null };

  const patch = Object.fromEntries(changed.filter((k) => k in data).map((k) => [k, data[k]]));
  if (Object.keys(patch).length) {
    if (employee) await prisma.employee.update({ where: { id: employee.id }, data: patch });
    else await prisma.intern.update({ where: { id: intern!.id }, data: patch });
  }
  if (termsUpdate) {
    await prisma.startupJoinRequest.update({ where: { id: termsUpdate.requestId }, data: { offerTerms: termsUpdate.terms as any } });
  }

  await audit({
    action: "hrms.person_updated",
    entity: kind === "EMPLOYEE" ? "Employee" : "Intern",
    entityId: args.personId,
    actorId: args.actorId,
    startupId: args.startupId,
    metadata: { fields: changed, message: `Changed ${changed.map((k) => LABELS[k] ?? k).join(", ")}` },
  });

  // Anything printed on their offer letter changed → issue the revised letter now.
  const onLetter = changed.some((k) => (LETTER_FIELDS as readonly string[]).includes(k) || k === "workMode" || k === "location");
  const letter = onLetter ? await regenerateOfferLetter(args.personId, args.startupId, args.actorId) : null;

  return { ...(await getPerson(args.startupId, args.personId)), letter };
}
