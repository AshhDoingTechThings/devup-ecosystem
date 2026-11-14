/**
 * Moves HR documents issued before the private-storage change out of the
 * public documents bucket.
 *
 *   npx ts-node scripts/move-hr-documents-private.ts                 # dry run: lists what would move
 *   npx ts-node scripts/move-hr-documents-private.ts --apply         # copy to private + relink
 *   npx ts-node scripts/move-hr-documents-private.ts --apply --delete-public
 *                                                                    # ...and remove the public copies
 *
 * Production data: run only with explicit approval, after the
 * 2026_startup_affiliation.sql migration (it adds HrDocument.storagePath).
 */
import { moveLegacyHrDocuments } from "../src/modules/hrms/documents/moveToPrivate";
import { prisma } from "../src/lib/prisma";

async function main() {
  const apply = process.argv.includes("--apply");
  const deletePublic = process.argv.includes("--delete-public");
  if (deletePublic && !apply) throw new Error("--delete-public needs --apply");

  const r = await moveLegacyHrDocuments({ apply, deletePublic });
  for (const i of r.items) console.log(`${i.action.padEnd(6)} ${i.documentNo}${i.detail ? ` — ${i.detail}` : ""}`);
  console.log(`\n${apply ? "APPLIED" : "DRY RUN"}: ${r.total} legacy documents, ${r.moved} moved, ${r.skipped} skipped, ${r.failed} failed`);
  if (r.failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
