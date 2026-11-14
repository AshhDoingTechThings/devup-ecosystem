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

  const supervisorId = isIntern ? req.intern?.mentorId : req.employee?.managerId;
  const supervisor = supervisorId
    ? await prisma.user.findUnique({ where: { id: supervisorId }, select: { profile: { select: { name: true } } } })
    : null;
  const terms = (req.offerTerms ?? {}) as { workMode?: string; location?: string };
  const start = isIntern ? req.intern!.startDate : req.employee!.joinedAt;
  const end = isIntern ? req.intern!.endDate : null;

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
              durationMonths: end
                ? Math.max(1, Math.round((end.getTime() - start.getTime()) / (30 * 864e5)))
                : undefined,
              workMode: terms.workMode ?? "OFFICE",
              location: terms.location,
              reportingTo: supervisor?.profile?.name,
            },
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
  const outcome = await notify({
    userId: req.userId,
    event: "OFFER_GENERATED",
    title: `Your ${isIntern ? "internship " : ""}offer letter — ${req.startup.name}`,
    message: `${req.startup.name} has issued your offer letter (${doc.documentNo}).`,
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
      reportingTo: supervisor?.profile?.name ?? null,
      workLocation: terms.location ?? null,
    }),
    attachments: [{ filename: `Offer-Letter-${doc.documentNo.replace(/\//g, "-")}.pdf`, content: file.pdfBuffer }],
  });

  if (outcome.email === "sent" || outcome.email === "queued") return finish("SENT", null, doc.documentNo);
  return finish("FAILED", `EMAIL_${outcome.error ?? "FAILED"}`.slice(0, 80), doc.documentNo);
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
