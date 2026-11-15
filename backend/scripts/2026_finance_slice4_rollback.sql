-- Rollback: CFO finance portal — slice 4 (2026_finance_slice4.sql).
--
-- Removes startup bills, receipts, reminders, income entries and
-- collaborations. REFUSES if any of them exist. To discard them anyway:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--     -c "SET devup.rollback_force = 'yes'" -f backend/scripts/2026_finance_slice4_rollback.sql
--
-- Deploy a backend without slice 4 BEFORE running this.

BEGIN;

DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('"FinanceInvoice"') IS NOT NULL THEN
    SELECT (SELECT count(*) FROM "FinanceInvoice") + (SELECT count(*) FROM "IncomeEntry") + (SELECT count(*) FROM "Collaboration") INTO n;
  END IF;
  IF n > 0 AND coalesce(current_setting('devup.rollback_force', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing to roll back: % slice-4 record(s) exist. Set devup.rollback_force = ''yes'' to discard them.', n;
  END IF;
END $$;

DROP TABLE IF EXISTS "PaymentReminder";
DROP TABLE IF EXISTS "InvoiceReceipt";
DROP TABLE IF EXISTS "FinanceInvoice";
DROP TABLE IF EXISTS "IncomeEntry";
DROP TABLE IF EXISTS "CollaborationShare";
DROP TABLE IF EXISTS "Collaboration";
DROP TYPE IF EXISTS "FinanceInvoiceStatus";
DROP TYPE IF EXISTS "IncomeSource";
DROP TYPE IF EXISTS "CollaborationStatus";

COMMIT;
