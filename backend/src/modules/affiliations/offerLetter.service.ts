import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { logger } from "../../middleware/logger";
import { nextOfferNo, offerExpiryFor } from "../../lib/numbering";
import { Emails } from "../../lib/email/templates";
import { issue, attachFile } from "../hrms/documents/document.service";
import { renderDocument, TemplateKey } from "../hrms/documents/templates";
import { audit } from "../shared/audit.service";
import { notify } from "../shared/notification.service";

/**
 * The offer letter sent when a startup approves someone's request.
 *
 * Nothing new is generated here: the letter comes from THE document generator
 * (document.service `issue` + `attachFile`, template OFFER_LETTER, numbering
 * `nextOfferNo`), the same path a direct hire's offer takes, and goes out
 * through the same notification mailer with the PDF attached.
 *
 * What this adds is delivery bookkeeping, because the approval and the email
 * are separate things that fail separately:
 *   - the approval stands even if the letter fails (a mail outage must not
 *     undo someone's membership)
 *   - the result is persisted on the request (SENT / FAILED + reason)
 *   - a retry re-sends the SAME document and number; a number is allocated
 *     exactly once, inside the transaction that creates the document
 *   - a letter already SENT is never sent again by a retry
 */

export type OfferResult = {
  status: "SENT" | "FAILED";
  documentNo: string | null;
  error: string | null;
  attempts: number;
};

/** A stuck SENDING (the server died mid-send) becomes retryable after this. */
export const STALE_SENDING_MS = 10 * 60_000;

/** Reasons an admin can act on; no personal data. */
const REASON_TEXT: Record<string, string> = {
  BRANDING_MISSING: "Add the startup's legal name and signatory in workspace Settings, then retry.",
  PDF_UNAVAILABLE: "The PDF renderer is unavailable on the server. Retry once it is fixed.",
  NO_RECORD: "The person's HR record is missing.",
  STORAGE_FAILED: "The letter was generated but could not be saved to private storage. Retry shortly.",
  ISSUE_FAILED: "The letter could not be generated.",
};
export const offerReasonText = (code?: string | null) =>
  !code ? null : REASON_TEXT[code] ?? (code.startsWith("EMAIL_") ? "The email could not be delivered. Retry later." : "Something went wrong.");

/**
 * Generate (once) and email the offer letter for an approved request whose
 * offerStatus has already been claimed as SENDING by the caller.
 * Never throws: every outcome is recorded and returned.
 */
export async function deliverOfferLetter(requestId: string, actorId: string): Promise<OfferResult> {
  const req = await prisma.startupJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      intern: true,
      employee: true,
      offerDocument: true,
      startup: { select: { id: true, name: true, code: true, logoUrl: true } },
    },
  });
  if (!req) return { status: "FAILED", documentNo: null, error: "NOT_FOUND", attempts: 0 };

  const finish = async (status: "SENT" | "FAILED", error: string | null, documentNo: string | null) => {
    const updated = await prisma.startupJoinRequest.update({
      where: { id: req.id },
      data: {
        offerStatus: status,
        offerError: error,
        offerAttempts: { increment: 1 },
        ...(status === "SENT" ? { offerSentAt: new Date() } : {}),
      },
      select: { offerAttempts: true },
    });
    await audit({
      action: status === "SENT" ? "affiliation.offer_sent" : "affiliation.offer_failed",
      entity: "StartupJoinRequest",
      entityId: req.id,
      actorId,
      startupId: req.startupId,
      metadata: { documentNo, error, attempt: updated.offerAttempts },
    }).catch(() => undefined);
    // Tell the approving admin how it went, so a failure is never silent.
    await notify({
      userId: actorId,
      event: "OFFER_GENERATED",
      title: status === "SENT" ? `Offer letter sent — ${req.fullName}` : `Offer letter not sent — ${req.fullName}`,
      message: status === "SENT"
        ? `${documentNo} was emailed to ${req.fullName} with the PDF attached.`
        : `${offerReasonText(error)} Open the request in Team Requests to retry.`,
      link: `/s/${req.startup.code}/requests`,
      channel: "inapp",
    }).catch(() => undefined);
    if (status === "FAILED") logger.warn(`offer letter for request ${req.id} failed: ${error}`);
    return { status, documentNo, error, attempts: updated.offerAttempts };
  };

  const isIntern = req.kind === "INTERN";
  const person = isIntern ? req.intern : req.employee;
  if (!person) return finish("FAILED", "NO_RECORD", null);
  const { payload, start, supervisorName, terms } = await offerPayload(req);

  // 1. The document — issued once. A retry finds it linked and reuses it.
  let doc = req.offerDocument;
  if (!doc) {
    try {
      doc = await prisma.$transaction(async (tx) => {
        const documentNo = await nextOfferNo(tx, req.startupId, req.startup.code ?? "GEN");
        return issue(
          {
            startupId: req.startupId,
            docType: "OFFER_LETTER",
            documentNo,
            templateKey: "OFFER_LETTER",
            internId: isIntern ? person.id : undefined,
            employeeId: isIntern ? undefined : person.id,
            issuedBy: actorId,
            payload,
          },
          tx
        );
      });
      await prisma.startupJoinRequest.update({ where: { id: req.id }, data: { offerDocumentId: doc.id } });
    } catch (err) {
      const code = err instanceof AppError && err.code === "BRANDING_MISSING" ? "BRANDING_MISSING" : "ISSUE_FAILED";
      if (code === "ISSUE_FAILED") logger.error(`offer letter issue failed for request ${req.id}: ${(err as Error).message}`);
      return finish("FAILED", code, null);
    }
  }

  // 2. The file — re-rendered from the frozen payload, so it is byte-for-byte
  //    the letter that was issued, never a rewrite.
  const html = renderDocument(doc.templateKey as TemplateKey, doc.payload as Record<string, unknown>);
  const file = await attachFile(
    { id: doc.id, docType: doc.docType, startupId: doc.startupId, documentNo: doc.documentNo },
    html
  );
  if (!file.pdfBuffer) return finish("FAILED", "PDF_UNAVAILABLE", doc.documentNo);
  // Not emailed until it is also on their dashboard: a retry then sends exactly
  // one email, and the copy they can download later is the one they were sent.
  if (!file.stored) return finish("FAILED", "STORAGE_FAILED", doc.documentNo);

  // 3. The email — to the account's own verified address, PDF attached.
  const replaces = doc.supersedesId
    ? (await prisma.hrDocument.findUnique({ where: { id: doc.supersedesId }, select: { documentNo: true } }))?.documentNo ?? null
    : null;
  const outcome = await notify({
    userId: req.userId,
    event: "OFFER_GENERATED",
    title: `Your ${replaces ? "revised " : ""}${isIntern ? "internship " : ""}offer letter — ${req.startup.name}`,
    message: replaces
      ? `${req.startup.name} has issued a revised offer letter (${doc.documentNo}). It replaces ${replaces}.`
      : `${req.startup.name} has issued your offer letter (${doc.documentNo}).`,
    link: isIntern ? `/dashboard/internship?startup=${req.startup.code}` : `/dashboard/employment?startup=${req.startup.code}`,
    html: Emails.offerGenerated({
      name: person.fullName,
      designation: person.designation,
      startupName: req.startup.name,
      offerNo: doc.documentNo,
      joiningDate: start.toLocaleDateString("en-IN", { dateStyle: "long" }),
      expiresAt: offerExpiryFor(start).toLocaleDateString("en-IN", { dateStyle: "long" }),
      ctc: isIntern ? undefined : req.employee!.ctc,
      stipend: isIntern ? req.intern!.stipend : undefined,
      logoUrl: req.startup.logoUrl,
      reportingTo: supervisorName,
      workLocation: terms.location ?? null,
      replaces,
    }),
    attachments: [{ filename: `Offer-Letter-${doc.documentNo.replace(/\//g, "-")}.pdf`, content: file.pdfBuffer }],
  });

  if (outcome.email === "sent" || outcome.email === "queued") return finish("SENT", null, doc.documentNo);
  return finish("FAILED", `EMAIL_${outcome.error ?? "FAILED"}`.slice(0, 80), doc.documentNo);
}

type RequestWithPeople = Prisma.StartupJoinRequestGetPayload<{
  include: { intern: true; employee: true; startup: { select: { id: true; name: true; code: true; logoUrl: true } } };
}>;

/** What the letter says, from the person's record as it is now. */
async function offerPayload(req: RequestWithPeople) {
  const isIntern = req.kind === "INTERN";
  const person = (isIntern ? req.intern : req.employee)!;
  const supervisorId = isIntern ? req.intern?.mentorId : req.employee?.managerId;
  const supervisor = supervisorId
    ? await prisma.user.findUnique({ where: { id: supervisorId }, select: { profile: { select: { name: true } } } })
    : null;
  const terms = (req.offerTerms ?? {}) as { workMode?: string; location?: string };
  const start = isIntern ? req.intern!.startDate : req.employee!.joinedAt;
  const end = isIntern ? req.intern!.endDate : null;
  return {
    start,
    terms,
    supervisorName: supervisor?.profile?.name ?? null,
    payload: {
      candidateName: person.fullName,
      designation: person.designation,
      department: person.department,
      employmentType: isIntern ? "INTERNSHIP" : req.employee!.employmentType,
      ctc: isIntern ? undefined : req.employee!.ctc,
      stipend: isIntern ? req.intern!.stipend : undefined,
      joiningDate: start,
      expiresAt: offerExpiryFor(start),
      documentsDueBy: offerExpiryFor(start),
      durationMonths: end ? Math.max(1, Math.round((end.getTime() - start.getTime()) / (30 * 864e5))) : undefined,
      workMode: terms.workMode ?? "OFFICE",
      location: terms.location,
      reportingTo: supervisor?.profile?.name,
    } as Record<string, unknown>,
  };
}

/** Record fields that appear on the offer letter. Editing one of these regenerates it. */
export const LETTER_FIELDS = [
  "fullName", "designation", "department", "employmentType", "ctc", "stipend",
  "startDate", "endDate", "joinedAt", "mentorId", "managerId",
] as const;

export type RegenerateResult =
  | { regenerated: true; requestId: string; documentNo: string; previousDocumentNo: string; ready: boolean; error: string | null; message: string | null }
  | { regenerated: false; requestId: string | null; reason: "NO_LETTER" | "SENDING" | "FAILED"; message: string | null };

/**
 * After a person's details change, issue a revised offer letter from the
 * record as it is now. Issued letters are frozen legal records, so the old one
 * is not rewritten: it is revoked (kept, marked superseded) and a new letter
 * with its own number replaces it on the request. Nothing is emailed here;
 * the revised letter waits as "ready to send" until an admin sends it.
 *
 * Never throws: the edit that triggered this has already been saved.
 */
export async function regenerateOfferLetter(personId: string, startupId: string, actorId: string): Promise<RegenerateResult> {
  const found = await prisma.startupJoinRequest.findFirst({
    where: { startupId, status: "APPROVED", offerDocumentId: { not: null }, OR: [{ internId: personId }, { employeeId: personId }] },
    orderBy: { reviewedAt: "desc" },
    select: { id: true },
  });
  if (!found) return { regenerated: false, requestId: null, reason: "NO_LETTER", message: null };

  // Same lock the sender uses, so a letter is never replaced mid-send.
  const stale = new Date(Date.now() - STALE_SENDING_MS);
  const claimed = await prisma.startupJoinRequest.updateMany({
    where: {
      id: found.id,
      OR: [{ offerStatus: null }, { offerStatus: { in: ["FAILED", "SENT"] } }, { offerStatus: "SENDING", updatedAt: { lt: stale } }],
    },
    data: { offerStatus: "SENDING" },
  });
  if (claimed.count !== 1) {
    return { regenerated: false, requestId: found.id, reason: "SENDING", message: "The offer letter is being sent right now, so it was not regenerated. Edit again once it finishes." };
  }

  const req = await prisma.startupJoinRequest.findUniqueOrThrow({
    where: { id: found.id },
    include: { intern: true, employee: true, offerDocument: true, startup: { select: { id: true, name: true, code: true, logoUrl: true } } },
  });
  const old = req.offerDocument!;
  const restore = () =>
    prisma.startupJoinRequest.update({
      where: { id: req.id },
      data: { offerStatus: req.offerStatus === "SENDING" ? "FAILED" : req.offerStatus },
    });

  if (!(req.kind === "INTERN" ? req.intern : req.employee)) {
    await restore();
    return { regenerated: false, requestId: req.id, reason: "FAILED", message: offerReasonText("NO_RECORD") };
  }

  let doc: Awaited<ReturnType<typeof issue>>;
  try {
    const { payload } = await offerPayload(req);
    doc = await prisma.$transaction(async (tx) => {
      const documentNo = await nextOfferNo(tx, req.startupId, req.startup.code ?? "GEN");
      const created = await issue(
        {
          startupId: req.startupId,
          docType: "OFFER_LETTER",
          documentNo,
          templateKey: "OFFER_LETTER",
          internId: req.kind === "INTERN" ? req.intern!.id : undefined,
          employeeId: req.kind === "INTERN" ? undefined : req.employee!.id,
          issuedBy: actorId,
          supersedesId: old.id,
          payload,
        },
        tx
      );
      if (!old.revokedAt) {
        await tx.hrDocument.update({
          where: { id: old.id },
          data: { revokedAt: new Date(), revokeReason: `Superseded by ${documentNo} after the details were edited` },
        });
      }
      // Ready to send: a letter is linked, none of it has been emailed yet.
      await tx.startupJoinRequest.update({
        where: { id: req.id },
        data: { offerDocumentId: created.id, offerStatus: null, offerError: null, offerSentAt: null },
      });
      return created;
    });
  } catch (err) {
    const code = err instanceof AppError && err.code === "BRANDING_MISSING" ? "BRANDING_MISSING" : "ISSUE_FAILED";
    if (code === "ISSUE_FAILED") logger.error(`offer letter regenerate failed for request ${req.id}: ${(err as Error).message}`);
    await restore();
    return { regenerated: false, requestId: req.id, reason: "FAILED", message: offerReasonText(code) };
  }

  // The file. If it can't be rendered or stored now, the revised letter is
  // still the one on record; sending retries the file before emailing.
  const file = await attachFile({ id: doc.id, docType: doc.docType, startupId: doc.startupId, documentNo: doc.documentNo }, doc.html);
  const error = !file.pdfBuffer ? "PDF_UNAVAILABLE" : !file.stored ? "STORAGE_FAILED" : null;
  if (error) await prisma.startupJoinRequest.update({ where: { id: req.id }, data: { offerStatus: "FAILED", offerError: error } });

  await audit({
    action: "affiliation.offer_regenerated",
    entity: "StartupJoinRequest",
    entityId: req.id,
    actorId,
    startupId: req.startupId,
    metadata: { documentNo: doc.documentNo, replaces: old.documentNo, message: `${doc.documentNo} replaces ${old.documentNo}` },
  }).catch(() => undefined);

  return {
    regenerated: true,
    requestId: req.id,
    documentNo: doc.documentNo,
    previousDocumentNo: old.documentNo,
    ready: !error,
    error,
    message: error ? offerReasonText(error) : null,
  };
}

/**
 * Claim a request's letter for (re)sending. Only one sender at a time; a
 * letter already SENT is never re-sent; a SENDING left behind by a crash is
 * retryable after STALE_SENDING_MS.
 */
export async function claimOffer(requestId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const stale = new Date(Date.now() - STALE_SENDING_MS);
  const res = await tx.startupJoinRequest.updateMany({
    where: {
      id: requestId,
      status: "APPROVED",
      OR: [{ offerStatus: null }, { offerStatus: "FAILED" }, { offerStatus: "SENDING", updatedAt: { lt: stale } }],
    },
    data: { offerStatus: "SENDING", offerError: null },
  });
  return res.count === 1;
}

/** Admin action: send (or re-send after a failure) the offer letter. */
export async function retryOfferLetter(args: { startupId: string; requestId: string; actorId: string }) {
  const req = await prisma.startupJoinRequest.findFirst({
    where: { id: args.requestId, startupId: args.startupId },
    select: { id: true, status: true, offerStatus: true },
  });
  if (!req) throw new AppError(404, "Request not found", "NOT_FOUND");
  if (req.status !== "APPROVED") throw new AppError(409, "Only an approved request has an offer letter.", "NOT_APPROVED");
  if (req.offerStatus === "SENT") {
    throw new AppError(409, "This offer letter was already delivered. It is not sent twice.", "ALREADY_SENT");
  }
  if (!(await claimOffer(req.id))) {
    throw new AppError(409, "This offer letter is being sent right now.", "IN_PROGRESS");
  }
  return deliverOfferLetter(req.id, args.actorId);
}
