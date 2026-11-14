import { prisma } from "../../../lib/prisma";
import { supabaseAdmin } from "../../../config/supabase";
import { env } from "../../../config/env";
import { uploadPrivateFile } from "../../../lib/storage";
import { hrDocumentsBucket } from "./documentFiles";

/**
 * One-off backfill: HR documents issued before files moved to private storage
 * still have a public URL in the shared documents bucket. This copies each file
 * into the private bucket, points the record at it and (optionally) removes the
 * public copy so the old URL stops working.
 *
 * Dry run unless `apply` is set. Per-document failures are reported and skipped;
 * nothing is changed for a document whose copy did not succeed.
 */
export interface MoveResult {
  total: number;
  moved: number;
  skipped: number;
  failed: number;
  items: { documentNo: string; action: "move" | "moved" | "skip" | "failed"; detail?: string }[];
}

export function publicObjectPath(url: string, bucket = env.STORAGE_BUCKET_DOCUMENTS): string | null {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const at = url.indexOf(marker);
  if (at < 0) return null;
  const rest = url.slice(at + marker.length).split("?")[0];
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

export async function moveLegacyHrDocuments(opts: { apply: boolean; deletePublic: boolean }): Promise<MoveResult> {
  const docs = await prisma.hrDocument.findMany({
    where: { storagePath: null, pdfUrl: { not: null } },
    select: { id: true, documentNo: true, docType: true, startupId: true, pdfUrl: true },
    orderBy: { issuedAt: "asc" },
  });

  const result: MoveResult = { total: docs.length, moved: 0, skipped: 0, failed: 0, items: [] };
  const publicBucket = env.STORAGE_BUCKET_DOCUMENTS;

  for (const doc of docs) {
    const objectPath = publicObjectPath(doc.pdfUrl!, publicBucket);
    if (!objectPath) {
      result.skipped++;
      result.items.push({ documentNo: doc.documentNo, action: "skip", detail: "not a file in the public documents bucket" });
      continue;
    }
    const isPdf = objectPath.toLowerCase().endsWith(".pdf");
    const target = `hr-documents/${doc.startupId}/${doc.docType.toLowerCase()}/${doc.id}.${isPdf ? "pdf" : "html"}`;

    if (!opts.apply) {
      result.items.push({ documentNo: doc.documentNo, action: "move" });
      continue;
    }

    try {
      const { data, error } = await supabaseAdmin.storage.from(publicBucket).download(objectPath);
      if (error || !data) throw new Error(`download failed: ${error?.message ?? "no data"}`);
      const bytes = Buffer.from(await data.arrayBuffer());
      const storagePath = await uploadPrivateFile(hrDocumentsBucket(), target, bytes, isPdf ? "application/pdf" : "text/plain");
      await prisma.hrDocument.update({ where: { id: doc.id }, data: { storagePath, pdfUrl: null } });

      if (opts.deletePublic) {
        const { error: rmErr } = await supabaseAdmin.storage.from(publicBucket).remove([objectPath]);
        if (rmErr) throw new Error(`copied and relinked, but the public copy could not be removed: ${rmErr.message}`);
      }
      result.moved++;
      result.items.push({ documentNo: doc.documentNo, action: "moved" });
    } catch (err) {
      result.failed++;
      result.items.push({ documentNo: doc.documentNo, action: "failed", detail: (err as Error).message });
    }
  }
  return result;
}
