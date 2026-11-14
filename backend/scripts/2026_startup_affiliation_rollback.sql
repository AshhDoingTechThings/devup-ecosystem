-- Rollback for 2026_startup_affiliation.sql.
--
-- ORDER: first redeploy the previous backend (the code before
-- feature/startup-affiliation), THEN run this. The new backend cannot run
-- without these objects, and the old one cannot read a member whose status is
-- DEACTIVATED.
--
-- Take a backup first. This drops the join-request table (all employee/intern
-- requests and their history links) — data that exists only because the
-- feature ran.
--
-- Guarded: it stops, changing nothing, if the feature has left data the old
-- code cannot read:
--   * members with status DEACTIVATED
--   * issued documents stored privately (HrDocument.storagePath set)
--   * any join requests
-- To proceed anyway, in the same psql session:
--   SET devup.rollback_force = 'yes';
-- With force: DEACTIVATED memberships are deleted (what "remove from startup"
-- did before this feature); privately stored documents keep their record and
-- number but lose the file link — use "regenerate" after rollback to rebuild
-- the file under the same number. The private files themselves are not
-- deleted; there is no reverse of scripts/move-hr-documents-private.ts.
--
-- The enum value StartupMemberStatus.DEACTIVATED is left in place: Postgres
-- cannot drop an enum value, it is harmless once no row uses it, and the
-- forward script re-adds it with IF NOT EXISTS.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f backend/scripts/2026_startup_affiliation_rollback.sql

BEGIN;

DO $$
DECLARE
  deactivated int := 0;
  private_docs int := 0;
  requests int := 0;
  force boolean := coalesce(current_setting('devup.rollback_force', true), '') = 'yes';
BEGIN
  SELECT count(*) INTO deactivated FROM "StartupMember" WHERE status::text = 'DEACTIVATED';
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'HrDocument' AND column_name = 'storagePath') THEN
    EXECUTE 'SELECT count(*) FROM "HrDocument" WHERE "storagePath" IS NOT NULL' INTO private_docs;
  END IF;
  IF to_regclass('"StartupJoinRequest"') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM "StartupJoinRequest"' INTO requests;
  END IF;

  IF (deactivated + private_docs + requests) > 0 AND NOT force THEN
    RAISE EXCEPTION 'Rollback stopped, nothing changed: % deactivated members, % privately stored documents, % join requests. Back up, then SET devup.rollback_force = ''yes'' to proceed.',
      deactivated, private_docs, requests;
  END IF;

  IF deactivated > 0 THEN
    DELETE FROM "StartupMember" WHERE status::text = 'DEACTIVATED';
  END IF;
END $$;

DROP TABLE IF EXISTS "StartupJoinRequest";
DROP TYPE IF EXISTS "JoinRequestStatus";
DROP TYPE IF EXISTS "AffiliationKind";
DROP TYPE IF EXISTS "LetterDeliveryStatus";
ALTER TABLE "StartupMember" DROP COLUMN IF EXISTS "deactivatedAt";
ALTER TABLE "HrDocument" DROP COLUMN IF EXISTS "storagePath";
DROP INDEX IF EXISTS "AuditLog_entity_entityId_idx";

COMMIT;
