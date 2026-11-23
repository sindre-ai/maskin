-- Rollback for 0175_owner_approvals.sql. Drops every owner approval, which cannot be rebuilt. Roll
-- back the code that reads them first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "owner_approvals";
