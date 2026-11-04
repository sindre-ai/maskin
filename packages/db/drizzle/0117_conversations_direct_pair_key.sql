-- Store the direct message (DM) between two actors instead of deriving it.
--
-- Until now a 1-1 was "whichever chat has exactly these two active participants,
-- most recently used". A topical chat with one agent matches too, so the DM drifted
-- to whichever chat was used last. direct_pair_key marks the one DM per pair: the
-- two actor ids, lowest first, joined with ':'. NULL means a topical chat.
--
-- Step 1 of expand, migrate, contract: nothing reads the column until the code in
-- the same release does, and old code ignores it, so a revert loses nothing.
-- conversations is not on the hot-tables list (packages/db/MIGRATIONS.md) and the
-- backfill touches one row per person and agent pair, so it runs as one statement.
-- Rollback is drizzle/down/0117_conversations_direct_pair_key_down.sql.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "direct_pair_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_direct_pair_uniq"
	ON "conversations" USING btree ("workspace_id", "direct_pair_key")
	WHERE "direct_pair_key" IS NOT NULL;
--> statement-breakpoint
-- Backfill: for each person and agent pair, mark the chat the old lookup returned:
-- exactly two active participants, one person and one agent, most recently used
-- first (last_message_at, then id). Chats about a subject (a bet, task, insight or
-- loop) are left topical. Every other chat stays NULL.
-- uuid LEAST/GREATEST compare bytes, which orders lowercase hex like the app's sort.
UPDATE "conversations" c
SET "direct_pair_key" = picked.pair_key
FROM (
	SELECT DISTINCT ON (pairs.workspace_id, pairs.pair_key) pairs.id, pairs.pair_key
	FROM (
		SELECT
			c2.id,
			c2.workspace_id,
			c2.last_message_at,
			LEAST(p1.actor_id, p2.actor_id)::text || ':' || GREATEST(p1.actor_id, p2.actor_id)::text AS pair_key
		FROM "conversations" c2
		JOIN "conversation_participants" p1
			ON p1.conversation_id = c2.id AND p1.left_at IS NULL
		JOIN "conversation_participants" p2
			ON p2.conversation_id = c2.id AND p2.left_at IS NULL AND p2.actor_id > p1.actor_id
		JOIN "actors" a1 ON a1.id = p1.actor_id
		JOIN "actors" a2 ON a2.id = p2.actor_id
		WHERE c2.subject_id IS NULL
			AND c2.direct_pair_key IS NULL
			AND ((a1.type = 'human' AND a2.type = 'agent') OR (a1.type = 'agent' AND a2.type = 'human'))
			AND (
				SELECT count(*) FROM "conversation_participants" p
				WHERE p.conversation_id = c2.id AND p.left_at IS NULL
			) = 2
	) pairs
	ORDER BY pairs.workspace_id, pairs.pair_key, pairs.last_message_at DESC, pairs.id
) picked
WHERE c.id = picked.id;
