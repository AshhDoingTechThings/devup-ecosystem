import { env } from "../../../config/env";
import { signedUrl } from "../../../lib/storage";

/**
 * Links to issued HR documents.
 *
 * Files live in a private bucket and are reached only through signed links
 * that expire after LINK_TTL_SECONDS. Every caller must have already checked
 * that the viewer may see the document (tenant rank, or the document being the
 * viewer's own) — this module only turns a stored path into a link.
 *
 * Documents issued before the move still carry a public `pdfUrl`; those are
 * returned as-is until scripts/move_hr_documents_private.ts has been run.
 */

export const LINK_TTL_SECONDS = 300;

export const hrDocumentsBucket = () => env.STORAGE_BUCKET_HR_DOCUMENTS;

export type FileRef = { pdfUrl?: string | null; storagePath?: string | null };

export async function fileLink(doc: FileRef): Promise<string | null> {
  if (doc.storagePath) return signedUrl(hrDocumentsBucket(), doc.storagePath, LINK_TTL_SECONDS);
  return doc.pdfUrl ?? null;
}

/** Replaces `pdfUrl` with a fresh link and drops `storagePath` from the output. */
export async function withFileLink<T extends FileRef>(doc: T): Promise<Omit<T, "storagePath"> & { pdfUrl: string | null }> {
  const { storagePath: _omit, ...rest } = doc;
  return { ...rest, pdfUrl: await fileLink(doc) };
}

export function withFileLinks<T extends FileRef>(docs: T[]) {
  return Promise.all(docs.map(withFileLink));
}

/** Prisma `select` fragment for anything that needs to produce a link. */
export const FILE_SELECT = { pdfUrl: true, storagePath: true } as const;
