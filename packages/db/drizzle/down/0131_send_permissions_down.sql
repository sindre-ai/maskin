-- Rollback for 0131. Drops the send permission settings; nothing else depends on it. Once the
-- send gate reads this table, rolling back means every send waits for a person again only if
-- the gate change is rolled back too.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "send_permissions";
