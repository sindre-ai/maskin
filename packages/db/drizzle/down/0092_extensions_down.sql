-- Rollback for 0092_extensions.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Revert the code that reads and writes extensions first; this drops every
-- custom extension row in every workspace.
DROP TABLE IF EXISTS "extensions";
