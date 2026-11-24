-- Rollback for 0176_receipt_intake.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
--
-- Roll the code back first: the receipt routes read these tables and answer "off" or drop the mail
-- once they are gone. Receipt files already saved stay as ordinary files. Then drop the tables.
-- The file is recorded in "_migrations"; delete its row too if you want to re-apply it.
DROP TABLE IF EXISTS "receipt_intake_keys";
DROP TABLE IF EXISTS "receipt_intakes";
-- DELETE FROM "_migrations" WHERE name = '0176_receipt_intake.sql';
