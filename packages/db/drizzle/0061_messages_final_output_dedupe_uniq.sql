-- Idempotency guard for auto-posted end-of-turn agent output.
--
-- Load-bearing, not defensive: the local Docker log stream reconnects with
-- `tail: 'all'` on first connect (session-manager.ts streamContainerLogs), so
-- an apps/dev restart re-ingests a live session's entire log — including every
-- past turn's stream-json result envelope. Without this index that replay
-- would re-post every earlier turn into the conversation.
--
-- The key is a sha256 of the raw result line, so it is stable across replays
-- and distinct between turns (the line carries duration_ms, total_cost_usd and
-- token counts).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "messages_final_output_dedupe_uniq"
	ON "messages" ("session_id", (("metadata"->'final_output'->>'dedupe_key')))
	WHERE ("metadata"->'final_output'->>'dedupe_key') IS NOT NULL;
