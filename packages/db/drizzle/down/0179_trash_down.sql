-- Rollback for 0179_trash.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
--
-- Roll the code back first: the delete handlers write here and the restore route reads
-- here. Rows already in the trash are dropped with the table, so anything still
-- restorable is lost. Then drop the table.
-- The file is recorded in "_migrations"; delete its row too if you want to re-apply it.
DROP TABLE IF EXISTS "trash";
-- DELETE FROM "_migrations" WHERE name = '0179_trash.sql';
