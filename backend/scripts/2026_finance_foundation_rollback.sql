-- Rollback: CFO finance portal — foundation (2026_finance_foundation.sql).
--
-- Removes the finance tables, enums and guards. REFUSES if any finance record
-- exists (roles, expenses, vendors, pay, bank details, files), because those
-- are financial history. To discard them anyway, on purpose:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--     -c "SET devup.rollback_force = 'yes'" -f backend/scripts/2026_finance_foundation_rollback.sql
--
-- Deploy a backend without the finance module BEFORE running this.
-- Finance audit entries in AuditLog are kept (the guard is dropped, the rows stay).

BEGIN;

DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('"Expense"') IS NOT NULL THEN
    SELECT (SELECT count(*) FROM "Expense") + (SELECT count(*) FROM "FinanceRole") + (SELECT count(*) FROM "Vendor")
         + (SELECT count(*) FROM "EmployeeCompensation") + (SELECT count(*) FROM "PayeeBankAccount") + (SELECT count(*) FROM "FinanceAttachment")
      INTO n;
  END IF;
  IF n > 0 AND coalesce(current_setting('devup.rollback_force', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing to roll back: % finance record(s) exist. Set devup.rollback_force = ''yes'' to discard them.', n;
  END IF;
END $$;

DROP TRIGGER IF EXISTS devup_finance_audit_immutable ON "AuditLog";
DROP FUNCTION IF EXISTS devup_finance_audit_immutable();
DROP TRIGGER IF EXISTS devup_expense_guard ON "Expense";
DROP FUNCTION IF EXISTS devup_expense_guard();

DROP TABLE IF EXISTS "ExpenseAllocation";
DROP TABLE IF EXISTS "Expense";
DROP TABLE IF EXISTS "FinanceAttachment";
DROP TABLE IF EXISTS "FinanceSequence";
DROP TABLE IF EXISTS "FinanceCategory";
DROP TABLE IF EXISTS "Vendor";
DROP TABLE IF EXISTS "FinanceRole";
DROP TABLE IF EXISTS "EmployeeCompensation";
DROP TABLE IF EXISTS "PayeeBankAccount";

DROP TYPE IF EXISTS "AllocationMethod";
DROP TYPE IF EXISTS "PaymentMethod";
DROP TYPE IF EXISTS "ExpenseStatus";
DROP TYPE IF EXISTS "ExpenseKind";
DROP TYPE IF EXISTS "FinanceCategoryKind";
DROP TYPE IF EXISTS "FinanceRoleKind";
DROP TYPE IF EXISTS "PayFrequency";

COMMIT;
