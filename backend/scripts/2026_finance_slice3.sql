-- Migration: CFO finance portal — slice 3 (payroll and stipend runs).
--
-- Additive only. Nothing existing is rewritten or dropped:
--   * new enums PayrollKind, PayrollRunStatus, PayrollItemStatus
--   * new tables PayrollRun, PayrollItem
--   * new NULLABLE columns on StipendPayout: payrollRunId, paymentMethod,
--     failureReason, expenseId. Existing rows keep NULL; the workspace's
--     stipend screens behave exactly as before for them.
--   * Row Level Security ON for the new tables, no access for the Supabase
--     anon / authenticated roles
--
-- Requires 2026_finance_foundation.sql and 2026_finance_slice2.sql first.
-- Apply BEFORE deploying the backend that reads these objects:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f backend/scripts/2026_finance_slice3.sql
--
-- Safe to re-run. Never use `prisma db push` on the shared database.
-- Rollback: backend/scripts/2026_finance_slice3_rollback.sql (refuses if data exists).

BEGIN;

DO $$ BEGIN
  CREATE TYPE "PayrollKind" AS ENUM ('SALARY', 'STIPEND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'PROCESSING', 'PAID', 'PARTIALLY_PAID', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PayrollItemStatus" AS ENUM ('PENDING', 'ON_HOLD', 'PAID', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "StipendPayout" ADD COLUMN IF NOT EXISTS "expenseId" TEXT,
ADD COLUMN IF NOT EXISTS "failureReason" TEXT,
ADD COLUMN IF NOT EXISTS "paymentMethod" "PaymentMethod",
ADD COLUMN IF NOT EXISTS "payrollRunId" TEXT;

CREATE TABLE IF NOT EXISTS "PayrollRun" (
    "id" TEXT NOT NULL,
    "kind" "PayrollKind" NOT NULL,
    "startupId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "basis" TEXT NOT NULL DEFAULT 'FIXED',
    "preparedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "exportedAt" TIMESTAMP(3),
    "exportedBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PayrollItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "startupId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "basePaise" INTEGER NOT NULL,
    "workedDays" INTEGER NOT NULL,
    "periodDays" INTEGER NOT NULL,
    "components" JSONB NOT NULL,
    "adjustments" JSONB NOT NULL DEFAULT '[]',
    "netPaise" INTEGER NOT NULL,
    "status" "PayrollItemStatus" NOT NULL DEFAULT 'PENDING',
    "paidOn" DATE,
    "paymentRef" TEXT,
    "paymentMethod" "PaymentMethod",
    "failureReason" TEXT,
    "expenseId" TEXT,
    "isFinalSettlement" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayrollRun_kind_startupId_periodStart_idx" ON "PayrollRun"("kind", "startupId", "periodStart");

CREATE INDEX IF NOT EXISTS "PayrollItem_runId_idx" ON "PayrollItem"("runId");

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollItem_employeeId_periodStart_key" ON "PayrollItem"("employeeId", "periodStart");

DO $$ BEGIN
  ALTER TABLE "StipendPayout" ADD CONSTRAINT "StipendPayout_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Row Level Security: on, with no policies, and no grants to the API roles.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PayrollRun','PayrollItem'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
