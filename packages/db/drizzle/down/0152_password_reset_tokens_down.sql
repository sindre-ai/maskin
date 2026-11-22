-- Reverts 0152_password_reset_tokens.sql. Unused links are lost; people request a new one.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "password_reset_tokens";
