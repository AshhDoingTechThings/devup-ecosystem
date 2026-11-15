-- Migration: CFO finance portal — slice 2 (budgets, recurring bills,
-- subscriptions and seats, meetings and events).
--
-- Additive only. Nothing existing is rewritten or dropped:
--   * new enums BudgetScope, BudgetPeriod, RecurringFrequency,
--     SubscriptionStatus, FinanceEventKind, FinanceEventStatus
--   * new tables Budget, BudgetLine, RecurringBill, RecurringBillRun,
--     Subscription, SubscriptionSeat, FinanceEvent
--   * a new index on Expense(source, sourceId)
--   * Row Level Security ON for every new table, no access for the Supabase
--     anon / authenticated roles (this database's default privileges would
--     otherwise expose new tables to the public key)
--
-- Requires 2026_finance_foundation.sql first. Apply BEFORE deploying the
-- backend that reads these tables:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f backend/scripts/2026_finance_slice2.sql
--
-- Safe to re-run. Never use `prisma db push` on the shared database.
-- Rollback: backend/scripts/2026_finance_slice2_rollback.sql (refuses if data exists).

BEGIN;

DO $$ BEGIN
  CREATE TYPE "BudgetScope" AS ENUM ('ECOSYSTEM', 'CENTRAL', 'STARTUP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BudgetPeriod" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RecurringFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FinanceEventKind" AS ENUM ('TEAM_MEETING', 'STARTUP_MEETING', 'FOUNDER_MEETING', 'INVESTOR_MEETING', 'CLIENT_MEETING', 'TEAM_EVENT', 'WORKSHOP', 'TRAVEL', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FinanceEventStatus" AS ENUM ('PLANNED', 'DONE', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Budget" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "BudgetScope" NOT NULL,
    "startupId" TEXT,
    "purpose" TEXT,
    "period" "BudgetPeriod" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "approvalLimitPaise" INTEGER,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BudgetLine" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "categoryGroup" TEXT,
    "allocatedPaise" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RecurringBill" (
    "id" TEXT NOT NULL,
    "startupId" TEXT,
    "title" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "vendorId" TEXT,
    "payee" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "frequency" "RecurringFrequency" NOT NULL DEFAULT 'MONTHLY',
    "dueDay" INTEGER NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,
    "leadDays" INTEGER NOT NULL DEFAULT 5,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringBill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RecurringBillRun" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringBillRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Subscription" (
    "id" TEXT NOT NULL,
    "startupId" TEXT,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "plan" TEXT,
    "billingCycle" "RecurringFrequency" NOT NULL DEFAULT 'MONTHLY',
    "costPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "seatsPurchased" INTEGER,
    "renewalOn" DATE,
    "paymentMethodNote" TEXT,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelledAt" DATE,
    "responsibleUserId" TEXT,
    "categoryId" TEXT NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SubscriptionSeat" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "startupId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "confirmedBy" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "SubscriptionSeat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FinanceEvent" (
    "id" TEXT NOT NULL,
    "startupId" TEXT,
    "name" TEXT NOT NULL,
    "kind" "FinanceEventKind" NOT NULL DEFAULT 'TEAM_MEETING',
    "date" DATE NOT NULL,
    "startTime" TEXT,
    "purpose" TEXT,
    "location" TEXT,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "budgetId" TEXT,
    "status" "FinanceEventStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Budget_scope_startupId_periodStart_periodEnd_idx" ON "Budget"("scope", "startupId", "periodStart", "periodEnd");

CREATE UNIQUE INDEX IF NOT EXISTS "BudgetLine_budgetId_categoryGroup_key" ON "BudgetLine"("budgetId", "categoryGroup");

CREATE INDEX IF NOT EXISTS "RecurringBill_isActive_idx" ON "RecurringBill"("isActive");

CREATE UNIQUE INDEX IF NOT EXISTS "RecurringBillRun_billId_dueDate_key" ON "RecurringBillRun"("billId", "dueDate");

CREATE INDEX IF NOT EXISTS "Subscription_status_renewalOn_idx" ON "Subscription"("status", "renewalOn");

CREATE INDEX IF NOT EXISTS "SubscriptionSeat_subscriptionId_removedAt_idx" ON "SubscriptionSeat"("subscriptionId", "removedAt");

CREATE INDEX IF NOT EXISTS "FinanceEvent_startupId_date_idx" ON "FinanceEvent"("startupId", "date");

CREATE INDEX IF NOT EXISTS "Expense_source_sourceId_idx" ON "Expense"("source", "sourceId");

DO $$ BEGIN
  ALTER TABLE "Budget" ADD CONSTRAINT "Budget_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RecurringBillRun" ADD CONSTRAINT "RecurringBillRun_billId_fkey" FOREIGN KEY ("billId") REFERENCES "RecurringBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SubscriptionSeat" ADD CONSTRAINT "SubscriptionSeat_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SubscriptionSeat" ADD CONSTRAINT "SubscriptionSeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "FinanceEvent" ADD CONSTRAINT "FinanceEvent_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Row Level Security: on, with no policies, and no grants to the API roles.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Budget','BudgetLine','RecurringBill','RecurringBillRun','Subscription','SubscriptionSeat','FinanceEvent'] LOOP
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
