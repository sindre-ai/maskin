-- Rollback for migration 0047_knowledge_extras.sql.
--
-- This directory is deliberately outside packages/db/drizzle/ so the forward
-- migration runner (packages/db/src/migrate.ts) does NOT pick it up. It exists
-- to (a) document the reverse migration in-repo and (b) be executed by the
-- reversibility integration test in apps/dev/src/__tests__/integration/
-- knowledge-extras.test.ts to prove AC5 — up → down → up leaves the schema
-- byte-equal to the starting state.
--
-- CASCADE clears the migration row too so re-running the up path is clean.

DROP TABLE IF EXISTS "knowledge_extras" CASCADE;
DELETE FROM "_migrations" WHERE "name" = '0047_knowledge_extras.sql';
