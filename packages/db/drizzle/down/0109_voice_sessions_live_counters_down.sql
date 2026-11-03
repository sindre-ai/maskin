-- Rollback for 0109. Drops the running counters. Ended calls keep input_audio_seconds,
-- output_audio_seconds and total_cost_usd; only the turn and tool call counts are lost.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "voice_sessions"
	DROP COLUMN IF EXISTS "input_audio_ms",
	DROP COLUMN IF EXISTS "output_audio_ms",
	DROP COLUMN IF EXISTS "turn_count",
	DROP COLUMN IF EXISTS "tool_calls_count";
