-- Rollback for 0083_pro_cap_2000_to_4900.sql: intentionally a no-op.
--
-- The forward migration is a data correction (stale 2000 -> the documented Pro
-- cap of 4900) and does not record which rows it touched. Writing 2000 back
-- would also clobber every Pro workspace that legitimately holds 4900 (rows
-- written by the webhook after this release), so an inverse UPDATE is unsafe.
-- 4900 is also the correct Pro value for a code revert, so nothing needs
-- undoing. Lives under drizzle/down/ so the forward runner never picks it up.
SELECT 1;
