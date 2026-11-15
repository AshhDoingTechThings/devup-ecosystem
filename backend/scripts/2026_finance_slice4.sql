-- Migration: CFO finance portal — slice 4 (startup bills and reminders,
-- income received, collaborations).
--
-- Additive only. Nothing existing is rewritten or dropped:
--   * new enums FinanceInvoiceStatus, IncomeSource, CollaborationStatus
--   * new tables FinanceInvoice, InvoiceReceipt, PaymentReminder, IncomeEntry,
--     Collaboration, CollaborationShare
--   * Row Level Security ON for every new table, no access for the Supabase
--     anon / authenticated roles
--
-- Requires the foundation, slice 2 and slice 3 scripts first. Apply BEFORE
-- deploying the backend that reads these tables:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f backend/scripts/2026_finance_slice4.sql
--
-- Safe to re-run. Never use `prisma db push` on the shared database.
-- Rollback: backend/scripts/2026_finance_slice4_rollback.sql (refuses if data exists).

BEGIN;

DO $$ BEGIN
  CREATE TYPE "FinanceInvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PART_PAID', 'PAID', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "IncomeSource" AS ENUM ('CLIENT_PAYMENT', 'SERVICE_INCOME', 'PROJECT_INCOME', 'SPONSORSHIP', 'PARTNER_CONTRIBUTION', 'EVENT_INCOME', 'GRANT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CollaborationStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "FinanceInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "recipientStartupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "lines" JSONB NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "receivedPaise" INTEGER NOT NULL DEFAULT 0,
    "issueDate" DATE,
    "dueDate" DATE,
    "periodStart" DATE,
    "periodEnd" DATE,
    "status" "FinanceInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "flag" TEXT,
    "flagNote" TEXT,
    "billingEmail" TEXT,
    "viewToken" TEXT NOT NULL,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP(3),
    "maxReminders" INTEGER NOT NULL DEFAULT 4,
    "createdBy" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceInvoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InvoiceReceipt" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "receivedOn" DATE NOT NULL,
    "method" "PaymentMethod",
    "reference" TEXT,
    "note" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "reverseReason" TEXT,

    CONSTRAINT "InvoiceReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaymentReminder" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sentTo" TEXT NOT NULL,
    "sentBy" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "level" INTEGER NOT NULL,
    "delivery" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReminder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "IncomeEntry" (
    "id" TEXT NOT NULL,
    "startupId" TEXT,
    "source" "IncomeSource" NOT NULL,
    "title" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "receivedOn" DATE NOT NULL,
    "method" "PaymentMethod",
    "reference" TEXT,
    "collaborationId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "IncomeEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Collaboration" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "partnerName" TEXT NOT NULL,
    "partnerId" TEXT,
    "agreementId" TEXT,
    "status" "CollaborationStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" DATE,
    "endDate" DATE,
    "budgetPaise" INTEGER,
    "description" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collaboration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CollaborationShare" (
    "id" TEXT NOT NULL,
    "collaborationId" TEXT NOT NULL,
    "startupId" TEXT NOT NULL,
    "agreedContributionPaise" INTEGER,
    "note" TEXT,

    CONSTRAINT "CollaborationShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FinanceInvoice_number_key" ON "FinanceInvoice"("number");

CREATE UNIQUE INDEX IF NOT EXISTS "FinanceInvoice_viewToken_key" ON "FinanceInvoice"("viewToken");

CREATE INDEX IF NOT EXISTS "FinanceInvoice_recipientStartupId_status_idx" ON "FinanceInvoice"("recipientStartupId", "status");

CREATE INDEX IF NOT EXISTS "FinanceInvoice_status_dueDate_idx" ON "FinanceInvoice"("status", "dueDate");

CREATE INDEX IF NOT EXISTS "InvoiceReceipt_invoiceId_idx" ON "InvoiceReceipt"("invoiceId");

CREATE INDEX IF NOT EXISTS "PaymentReminder_invoiceId_createdAt_idx" ON "PaymentReminder"("invoiceId", "createdAt");

CREATE INDEX IF NOT EXISTS "IncomeEntry_startupId_receivedOn_idx" ON "IncomeEntry"("startupId", "receivedOn");

CREATE UNIQUE INDEX IF NOT EXISTS "CollaborationShare_collaborationId_startupId_key" ON "CollaborationShare"("collaborationId", "startupId");

DO $$ BEGIN
  ALTER TABLE "FinanceInvoice" ADD CONSTRAINT "FinanceInvoice_recipientStartupId_fkey" FOREIGN KEY ("recipientStartupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "InvoiceReceipt" ADD CONSTRAINT "InvoiceReceipt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "FinanceInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PaymentReminder" ADD CONSTRAINT "PaymentReminder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "FinanceInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_collaborationId_fkey" FOREIGN KEY ("collaborationId") REFERENCES "Collaboration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CollaborationShare" ADD CONSTRAINT "CollaborationShare_collaborationId_fkey" FOREIGN KEY ("collaborationId") REFERENCES "Collaboration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CollaborationShare" ADD CONSTRAINT "CollaborationShare_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Row Level Security: on, with no policies, and no grants to the API roles.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['FinanceInvoice','InvoiceReceipt','PaymentReminder','IncomeEntry','Collaboration','CollaborationShare'] LOOP
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
