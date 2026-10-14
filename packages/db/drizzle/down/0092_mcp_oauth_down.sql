-- Rollback for 0092_mcp_oauth.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Revert the code that reads and writes the oauth_* tables first. Dropping them
-- deletes every grant and token, so every connected Claude client has to reconnect.
DROP TABLE IF EXISTS "oauth_tokens";
DROP TABLE IF EXISTS "oauth_authorization_codes";
DROP TABLE IF EXISTS "oauth_grants";
