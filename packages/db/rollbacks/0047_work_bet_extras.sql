-- Rollback for migration 0047_work_bet_extras.sql.
--
-- This directory is deliberately outside packages/db/drizzle/ so the forward
-- migration runner (packages/db/src/migrate.ts) does NOT pick it up. It exists
-- to (a) document the reverse migration in-repo and (b) be executed by the
-- reversibility integration test in apps/dev/src/__tests__/integration/
-- work-bet-extras.test.ts to prove up → down → up leaves the schema
-- byte-equal to the starting state.
--
-- CASCADE clears the migration row too so re-running the up path is clean.

DROP TABLE IF EXISTS "work_bet_extras" CASCADE;
DELETE FROM "_migrations" WHERE "name" = '0047_work_bet_extras.sql';
