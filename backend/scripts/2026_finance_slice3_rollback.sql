-- Rollback: CFO finance portal — slice 3 (2026_finance_slice3.sql).
--
-- Removes payroll runs and items, and the four columns added to StipendPayout.
-- REFUSES if any payroll run exists or any stipend payout belongs to one,
-- because those are pay records. Expenses created for payments stay.
-- To discard them anyway, on purpose:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--     -c "SET devup.rollback_force = 'yes'" -f backend/scripts/2026_finance_slice3_rollback.sql
--
-- Deploy a backend without slice 3 BEFORE running this.

BEGIN;

DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('"PayrollRun"') IS NOT NULL THEN
    SELECT (SELECT count(*) FROM "PayrollRun") + (SELECT count(*) FROM "StipendPayout" WHERE "payrollRunId" IS NOT NULL) INTO n;
  END IF;
  IF n > 0 AND coalesce(current_setting('devup.rollback_force', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing to roll back: % payroll record(s) exist. Set devup.rollback_force = ''yes'' to discard them.', n;
  END IF;
END $$;

ALTER TABLE "StipendPayout" DROP CONSTRAINT IF EXISTS "StipendPayout_payrollRunId_fkey";
ALTER TABLE "StipendPayout" DROP COLUMN IF EXISTS "payrollRunId";
ALTER TABLE "StipendPayout" DROP COLUMN IF EXISTS "paymentMethod";
ALTER TABLE "StipendPayout" DROP COLUMN IF EXISTS "failureReason";
ALTER TABLE "StipendPayout" DROP COLUMN IF EXISTS "expenseId";
DROP TABLE IF EXISTS "PayrollItem";
DROP TABLE IF EXISTS "PayrollRun";
DROP TYPE IF EXISTS "PayrollItemStatus";
DROP TYPE IF EXISTS "PayrollRunStatus";
DROP TYPE IF EXISTS "PayrollKind";

COMMIT;
