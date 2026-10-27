-- Rollback for 0093_blocked_tool_calls.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Revert the code that reads and writes blocked_tool_calls first; this drops
-- the whole audit trail of refused tool calls.
DROP TABLE IF EXISTS "blocked_tool_calls";
