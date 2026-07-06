-- Rollback for migration 0048_crm_customer_extras.sql.
--
-- This directory is deliberately outside packages/db/drizzle/ so the forward
-- migration runner (packages/db/src/migrate.ts) does NOT pick it up. It exists
-- to (a) document the reverse migration in-repo and (b) be executed by the
-- reversibility integration test in apps/dev/src/__tests__/integration/
-- crm-customer-extras.test.ts to prove up → down → up leaves the schema
-- byte-equal to the starting state.
--
-- CASCADE clears the migration row too so re-running the up path is clean.

DROP TABLE IF EXISTS "crm_customer_extras" CASCADE;
DELETE FROM "_migrations" WHERE "name" = '0048_crm_customer_extras.sql';
