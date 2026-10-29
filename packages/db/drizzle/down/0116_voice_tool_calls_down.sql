-- Rollback for 0116. Drops the voice tool call log; nothing else depends on it.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "voice_tool_calls";
