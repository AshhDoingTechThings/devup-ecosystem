-- Migration: employee / intern join requests ("startup affiliation").
--
-- Additive only. Nothing existing is rewritten or dropped:
--   * new enums AffiliationKind, JoinRequestStatus
--   * new value StartupMemberStatus.DEACTIVATED
--   * new nullable column StartupMember.deactivatedAt
--   * new table StartupJoinRequest (+ indexes and foreign keys)
--   * new index on AuditLog(entity, entityId) for request history
--   * new enum LetterDeliveryStatus and offer-letter delivery columns on
--     StartupJoinRequest (which letter, sent/failed, why, attempts)
--   * new nullable column HrDocument.storagePath — issued letters now live in
--     the private bucket; existing rows keep their pdfUrl untouched (moving
--     old files is a separate, opt-in script: move-hr-documents-private.ts)
--
-- Apply BEFORE deploying the backend that reads these objects. The reverse
-- order makes every StartupMember query fail on the missing column:
--
--   psql "$DIRECT_URL" -f backend/scripts/2026_startup_affiliation.sql
--
-- Safe to re-run. Do NOT use `prisma db push` against the shared database.

-- Enum values cannot be added inside a transaction that then uses them, so
-- this runs on its own first. IF NOT EXISTS makes it re-runnable (PG 12+).
ALTER TYPE "StartupMemberStatus" ADD VALUE IF NOT EXISTS 'DEACTIVATED';

BEGIN;

DO $$ BEGIN
  CREATE TYPE "AffiliationKind" AS ENUM ('EMPLOYEE', 'INTERN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LetterDeliveryStatus" AS ENUM ('SENDING', 'SENT', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "JoinRequestStatus" AS ENUM ('PENDING', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "StartupMember" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "HrDocument" ADD COLUMN IF NOT EXISTS "storagePath" TEXT;

CREATE TABLE IF NOT EXISTS "StartupJoinRequest" (
    "id" TEXT NOT NULL,
    "startupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AffiliationKind" NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "department" TEXT,
    "designation" TEXT,
    "college" TEXT,
    "joiningDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "note" TEXT,
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "employeeId" TEXT,
    "internId" TEXT,
    "offerDocumentId" TEXT,
    "offerStatus" "LetterDeliveryStatus",
    "offerError" TEXT,
    "offerAttempts" INTEGER NOT NULL DEFAULT 0,
    "offerSentAt" TIMESTAMP(3),
    "offerTerms" JSONB,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StartupJoinRequest_pkey" PRIMARY KEY ("id")
);

-- For a database that already ran an earlier copy of this script.
ALTER TABLE "StartupJoinRequest" ADD COLUMN IF NOT EXISTS "offerDocumentId" TEXT;
ALTER TABLE "StartupJoinRequest" ADD COLUMN IF NOT EXISTS "offerStatus" "LetterDeliveryStatus";
ALTER TABLE "StartupJoinRequest" ADD COLUMN IF NOT EXISTS "offerError" TEXT;
ALTER TABLE "StartupJoinRequest" ADD COLUMN IF NOT EXISTS "offerAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StartupJoinRequest" ADD COLUMN IF NOT EXISTS "offerSentAt" TIMESTAMP(3);
ALTER TABLE "StartupJoinRequest" ADD COLUMN IF NOT EXISTS "offerTerms" JSONB;

CREATE INDEX IF NOT EXISTS "StartupJoinRequest_startupId_status_idx" ON "StartupJoinRequest"("startupId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "StartupJoinRequest_userId_startupId_key" ON "StartupJoinRequest"("userId", "startupId");
CREATE INDEX IF NOT EXISTS "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

DO $$ BEGIN
  ALTER TABLE "StartupJoinRequest" ADD CONSTRAINT "StartupJoinRequest_startupId_fkey"
    FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "StartupJoinRequest" ADD CONSTRAINT "StartupJoinRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "StartupJoinRequest" ADD CONSTRAINT "StartupJoinRequest_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "StartupJoinRequest" ADD CONSTRAINT "StartupJoinRequest_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "StartupJoinRequest" ADD CONSTRAINT "StartupJoinRequest_internId_fkey"
    FOREIGN KEY ("internId") REFERENCES "Intern"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "StartupJoinRequest" ADD CONSTRAINT "StartupJoinRequest_offerDocumentId_fkey"
    FOREIGN KEY ("offerDocumentId") REFERENCES "HrDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
