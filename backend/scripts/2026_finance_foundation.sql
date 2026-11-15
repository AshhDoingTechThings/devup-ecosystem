-- Migration: CFO finance portal — foundation (slice 1).
--
-- Additive only. Nothing existing is rewritten or dropped:
--   * new enums FinanceRoleKind, FinanceCategoryKind, ExpenseKind, ExpenseStatus,
--     PaymentMethod, AllocationMethod, PayFrequency
--   * new tables FinanceRole, FinanceCategory, Vendor, Expense, ExpenseAllocation,
--     FinanceAttachment, FinanceSequence, EmployeeCompensation, PayeeBankAccount
--   * Row Level Security ON for every new table, and no access for the Supabase
--     `anon` / `authenticated` roles. This database's default privileges grant
--     those roles full access to any NEW table, so without this a finance table
--     would be readable and writable with the public anon key. The backend
--     connects as the table owner and is unaffected.
--   * the default expense categories (configuration, not financial data)
--   * two guards in the database itself:
--       - finance audit entries (AuditLog.entity LIKE 'Finance%') cannot be
--         updated or deleted;
--       - an Expense row is never deleted, and a PAID expense's amount, owner,
--         dates, payment and status cannot be changed (corrections are new rows).
--
-- Apply BEFORE deploying the backend that reads these tables:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f backend/scripts/2026_finance_foundation.sql
--
-- Safe to re-run. Do NOT use `prisma db push` against the shared database: it
-- would drop the ~35 Rise*/Rising* tables another application keeps there.
-- Rollback: backend/scripts/2026_finance_foundation_rollback.sql (refuses if
-- any finance data exists).

BEGIN;

DO $$ BEGIN
  CREATE TYPE "FinanceRoleKind" AS ENUM ('ECOSYSTEM_CFO', 'STARTUP_FINANCE_MANAGER', 'FINANCE_VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FinanceCategoryKind" AS ENUM ('EXPENSE', 'INCOME');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ExpenseKind" AS ENUM ('VENDOR_BILL', 'REIMBURSEMENT', 'ADJUSTMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'PAID', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'UPI', 'CARD', 'CASH', 'CHEQUE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AllocationMethod" AS ENUM ('FIXED', 'PERCENT', 'HEADCOUNT', 'USAGE', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PayFrequency" AS ENUM ('MONTHLY', 'WEEKLY', 'BIWEEKLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "FinanceRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "FinanceRoleKind" NOT NULL,
    "startupId" TEXT,
    "grantedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "FinanceRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FinanceCategory" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "kind" "FinanceCategoryKind" NOT NULL DEFAULT 'EXPENSE',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "gstin" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Expense" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "startupId" TEXT,
    "kind" "ExpenseKind" NOT NULL DEFAULT 'VENDOR_BILL',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "businessPurpose" TEXT,
    "categoryId" TEXT NOT NULL,
    "vendorId" TEXT,
    "payee" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "originalAmount" INTEGER,
    "incurredOn" DATE NOT NULL,
    "dueOn" DATE,
    "paymentMethod" "PaymentMethod",
    "status" "ExpenseStatus" NOT NULL DEFAULT 'SUBMITTED',
    "claimantUserId" TEXT,
    "submittedBy" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "correctsId" TEXT,
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ExpenseAllocation" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "startupId" TEXT,
    "method" "AllocationMethod" NOT NULL,
    "basis" INTEGER,
    "amountPaise" INTEGER NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FinanceAttachment" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "startupId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'RECEIPT',
    "fileName" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "FinanceAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FinanceSequence" (
    "key" TEXT NOT NULL,
    "current" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FinanceSequence_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "EmployeeCompensation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "startupId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "annualCtcPaise" INTEGER,
    "monthlyGrossPaise" INTEGER NOT NULL,
    "components" JSONB NOT NULL,
    "frequency" "PayFrequency" NOT NULL DEFAULT 'MONTHLY',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "basis" TEXT NOT NULL DEFAULT 'ENTERED',
    "note" TEXT,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeCompensation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PayeeBankAccount" (
    "id" TEXT NOT NULL,
    "startupId" TEXT NOT NULL,
    "employeeId" TEXT,
    "internId" TEXT,
    "accountHolder" TEXT NOT NULL,
    "accountCipher" TEXT NOT NULL,
    "accountIv" TEXT NOT NULL,
    "accountTag" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "bankName" TEXT,
    "upiCipher" TEXT,
    "upiIv" TEXT,
    "upiTag" TEXT,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedBy" TEXT,

    CONSTRAINT "PayeeBankAccount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FinanceRole_userId_revokedAt_idx" ON "FinanceRole"("userId", "revokedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "FinanceCategory_key_key" ON "FinanceCategory"("key");

CREATE INDEX IF NOT EXISTS "Vendor_name_idx" ON "Vendor"("name");

CREATE UNIQUE INDEX IF NOT EXISTS "Expense_number_key" ON "Expense"("number");

CREATE INDEX IF NOT EXISTS "Expense_startupId_incurredOn_idx" ON "Expense"("startupId", "incurredOn");

CREATE INDEX IF NOT EXISTS "Expense_status_dueOn_idx" ON "Expense"("status", "dueOn");

CREATE INDEX IF NOT EXISTS "Expense_categoryId_idx" ON "Expense"("categoryId");

CREATE INDEX IF NOT EXISTS "Expense_claimantUserId_idx" ON "Expense"("claimantUserId");

CREATE INDEX IF NOT EXISTS "ExpenseAllocation_expenseId_idx" ON "ExpenseAllocation"("expenseId");

CREATE INDEX IF NOT EXISTS "ExpenseAllocation_startupId_idx" ON "ExpenseAllocation"("startupId");

CREATE INDEX IF NOT EXISTS "FinanceAttachment_entity_entityId_idx" ON "FinanceAttachment"("entity", "entityId");

CREATE INDEX IF NOT EXISTS "EmployeeCompensation_employeeId_effectiveFrom_idx" ON "EmployeeCompensation"("employeeId", "effectiveFrom");

CREATE INDEX IF NOT EXISTS "PayeeBankAccount_employeeId_idx" ON "PayeeBankAccount"("employeeId");

CREATE INDEX IF NOT EXISTS "PayeeBankAccount_internId_idx" ON "PayeeBankAccount"("internId");

DO $$ BEGIN
  ALTER TABLE "FinanceRole" ADD CONSTRAINT "FinanceRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "FinanceRole" ADD CONSTRAINT "FinanceRole_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Expense" ADD CONSTRAINT "Expense_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Expense" ADD CONSTRAINT "Expense_correctsId_fkey" FOREIGN KEY ("correctsId") REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ExpenseAllocation" ADD CONSTRAINT "ExpenseAllocation_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ExpenseAllocation" ADD CONSTRAINT "ExpenseAllocation_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "EmployeeCompensation" ADD CONSTRAINT "EmployeeCompensation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PayeeBankAccount" ADD CONSTRAINT "PayeeBankAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PayeeBankAccount" ADD CONSTRAINT "PayeeBankAccount_internId_fkey" FOREIGN KEY ("internId") REFERENCES "Intern"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Row Level Security: on, with no policies, and no grants to the API roles.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['FinanceRole','FinanceCategory','Vendor','Expense','ExpenseAllocation','FinanceAttachment','FinanceSequence','EmployeeCompensation','PayeeBankAccount'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- The Supabase API roles exist only on Supabase; skip quietly elsewhere.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;

-- Default categories. Never overwrites one the CFO renamed or switched off.
INSERT INTO "FinanceCategory" ("id", "key", "name", "group", "kind", "description", "isActive", "sortOrder", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, 'office_rent', 'Office rent', 'Office & operations', 'EXPENSE', 'Rent for office or co-working space', true, 0, now(), now()),
  (gen_random_uuid()::text, 'electricity', 'Electricity', 'Office & operations', 'EXPENSE', 'Electricity bills', true, 1, now(), now()),
  (gen_random_uuid()::text, 'water', 'Water', 'Office & operations', 'EXPENSE', 'Water bills and drinking water', true, 2, now(), now()),
  (gen_random_uuid()::text, 'internet', 'Internet', 'Office & operations', 'EXPENSE', 'Broadband and Wi-Fi', true, 3, now(), now()),
  (gen_random_uuid()::text, 'telephone', 'Telephone', 'Office & operations', 'EXPENSE', 'Phone lines and mobile plans', true, 4, now(), now()),
  (gen_random_uuid()::text, 'housekeeping', 'Housekeeping / maid', 'Office & operations', 'EXPENSE', 'Cleaning staff and housekeeping', true, 5, now(), now()),
  (gen_random_uuid()::text, 'office_maintenance', 'Office maintenance & repairs', 'Office & operations', 'EXPENSE', 'Repairs, servicing and upkeep', true, 6, now(), now()),
  (gen_random_uuid()::text, 'security', 'Security', 'Office & operations', 'EXPENSE', 'Guards and security services', true, 7, now(), now()),
  (gen_random_uuid()::text, 'office_supplies', 'Office supplies & stationery', 'Office & operations', 'EXPENSE', 'Stationery, printing, cleaning materials', true, 8, now(), now()),
  (gen_random_uuid()::text, 'refreshments', 'Refreshments', 'Office & operations', 'EXPENSE', 'Tea, coffee and snacks at the office', true, 9, now(), now()),
  (gen_random_uuid()::text, 'salaries', 'Salaries', 'People', 'EXPENSE', 'Employee salaries', true, 10, now(), now()),
  (gen_random_uuid()::text, 'stipends', 'Intern stipends', 'People', 'EXPENSE', 'Intern stipend payments', true, 11, now(), now()),
  (gen_random_uuid()::text, 'incentives', 'Bonuses & incentives', 'People', 'EXPENSE', 'Approved bonuses and incentives', true, 12, now(), now()),
  (gen_random_uuid()::text, 'training', 'Training & learning', 'People', 'EXPENSE', 'Courses, certifications, workshops attended', true, 13, now(), now()),
  (gen_random_uuid()::text, 'software', 'Software subscriptions', 'Software & tools', 'EXPENSE', 'SaaS and AI tools, licences', true, 14, now(), now()),
  (gen_random_uuid()::text, 'hosting', 'Hosting & cloud', 'Software & tools', 'EXPENSE', 'Servers, cloud, domains', true, 15, now(), now()),
  (gen_random_uuid()::text, 'meetings', 'Meetings', 'Meetings & events', 'EXPENSE', 'Team, founder, client and investor meetings', true, 16, now(), now()),
  (gen_random_uuid()::text, 'team_events', 'Team get-togethers', 'Meetings & events', 'EXPENSE', 'Dinners, celebrations, outings', true, 17, now(), now()),
  (gen_random_uuid()::text, 'events', 'Events & workshops', 'Meetings & events', 'EXPENSE', 'Hosting events, hackathons, workshops', true, 18, now(), now()),
  (gen_random_uuid()::text, 'food_hospitality', 'Food & hospitality', 'Meetings & events', 'EXPENSE', 'Food and hospitality for guests', true, 19, now(), now()),
  (gen_random_uuid()::text, 'travel', 'Travel', 'Travel', 'EXPENSE', 'Tickets, cabs, fuel', true, 20, now(), now()),
  (gen_random_uuid()::text, 'accommodation', 'Accommodation', 'Travel', 'EXPENSE', 'Hotels and stays', true, 21, now(), now()),
  (gen_random_uuid()::text, 'marketing', 'Marketing & advertising', 'Marketing', 'EXPENSE', 'Ads, promotions, printing for marketing', true, 22, now(), now()),
  (gen_random_uuid()::text, 'equipment', 'Equipment', 'Equipment', 'EXPENSE', 'Laptops, devices, hardware', true, 23, now(), now()),
  (gen_random_uuid()::text, 'furniture', 'Furniture', 'Equipment', 'EXPENSE', 'Desks, chairs, fittings', true, 24, now(), now()),
  (gen_random_uuid()::text, 'professional_fees', 'Professional fees', 'Professional services', 'EXPENSE', 'Legal, accounting, consultants', true, 25, now(), now()),
  (gen_random_uuid()::text, 'bank_charges', 'Bank charges', 'Professional services', 'EXPENSE', 'Bank and payment gateway fees', true, 26, now(), now()),
  (gen_random_uuid()::text, 'taxes_govt', 'Taxes & government fees', 'Professional services', 'EXPENSE', 'Registrations, filings, government fees', true, 27, now(), now()),
  (gen_random_uuid()::text, 'other', 'Other', 'Other', 'EXPENSE', 'Anything that fits nowhere else', true, 28, now(), now())
ON CONFLICT ("key") DO NOTHING;

-- Guard: finance audit entries are permanent.
CREATE OR REPLACE FUNCTION devup_finance_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."entity" LIKE 'Finance%' THEN
      RAISE EXCEPTION 'Finance audit entries cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."entity" LIKE 'Finance%' OR NEW."entity" LIKE 'Finance%' THEN
    RAISE EXCEPTION 'Finance audit entries cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS devup_finance_audit_immutable ON "AuditLog";
CREATE TRIGGER devup_finance_audit_immutable
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION devup_finance_audit_immutable();

-- Guard: expenses are never deleted, and a paid expense is final.
CREATE OR REPLACE FUNCTION devup_expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Expenses are never deleted — void or correct them instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'PAID' AND (
       NEW."status"      IS DISTINCT FROM OLD."status"
    OR NEW."amountPaise" IS DISTINCT FROM OLD."amountPaise"
    OR NEW."startupId"   IS DISTINCT FROM OLD."startupId"
    OR NEW."incurredOn"  IS DISTINCT FROM OLD."incurredOn"
    OR NEW."categoryId"  IS DISTINCT FROM OLD."categoryId"
    OR NEW."vendorId"    IS DISTINCT FROM OLD."vendorId"
    OR NEW."kind"        IS DISTINCT FROM OLD."kind"
    OR NEW."paidAt"      IS DISTINCT FROM OLD."paidAt"
    OR NEW."paymentRef"  IS DISTINCT FROM OLD."paymentRef"
    OR NEW."correctsId"  IS DISTINCT FROM OLD."correctsId"
    OR NEW."deletedAt"   IS DISTINCT FROM OLD."deletedAt"
  ) THEN
    RAISE EXCEPTION 'A paid expense cannot be changed — add a correction instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS devup_expense_guard ON "Expense";
CREATE TRIGGER devup_expense_guard
  BEFORE UPDATE OR DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION devup_expense_guard();

COMMIT;
