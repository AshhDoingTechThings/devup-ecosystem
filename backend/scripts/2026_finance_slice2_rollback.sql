-- Rollback: CFO finance portal — slice 2 (2026_finance_slice2.sql).
--
-- Removes budgets, recurring bills, subscriptions and events. REFUSES if any
-- of those records exist. Expenses those modules created stay (they are
-- ordinary expenses; their source/sourceId simply point at nothing).
-- To discard the records anyway, on purpose:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--     -c "SET devup.rollback_force = 'yes'" -f backend/scripts/2026_finance_slice2_rollback.sql
--
-- Deploy a backend without slice 2 BEFORE running this.

BEGIN;

DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('"Budget"') IS NOT NULL THEN
    SELECT (SELECT count(*) FROM "Budget") + (SELECT count(*) FROM "RecurringBill") + (SELECT count(*) FROM "Subscription") + (SELECT count(*) FROM "FinanceEvent") INTO n;
  END IF;
  IF n > 0 AND coalesce(current_setting('devup.rollback_force', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing to roll back: % slice-2 record(s) exist. Set devup.rollback_force = ''yes'' to discard them.', n;
  END IF;
END $$;

DROP INDEX IF EXISTS "Expense_source_sourceId_idx";
DROP TABLE IF EXISTS "BudgetLine";
DROP TABLE IF EXISTS "Budget";
DROP TABLE IF EXISTS "RecurringBillRun";
DROP TABLE IF EXISTS "RecurringBill";
DROP TABLE IF EXISTS "SubscriptionSeat";
DROP TABLE IF EXISTS "Subscription";
DROP TABLE IF EXISTS "FinanceEvent";

DROP TYPE IF EXISTS "BudgetScope";
DROP TYPE IF EXISTS "BudgetPeriod";
DROP TYPE IF EXISTS "RecurringFrequency";
DROP TYPE IF EXISTS "SubscriptionStatus";
DROP TYPE IF EXISTS "FinanceEventKind";
DROP TYPE IF EXISTS "FinanceEventStatus";

COMMIT;
