-- Give every person and agent pair a clean direct message (DM), and take the DM marker
-- off chats that grew into topical ones.
--
-- The 0117 backfill marked, per pair, the most recently used chat with exactly the two
-- of them. For an existing agent that is an old topical chat, so the "DM" opens on a
-- conversation about something else. This moves the marker: the old chat keeps its
-- title and every message and becomes an ordinary topical chat, and the pair gets a new
-- empty DM (titled with the agent's name, as findOrCreateDirectChat titles it).
--
-- Only a chat created before the 0117 backfill was merged (29 Oct 2026, 20:31 UTC) can
-- have been marked by it: the column did not exist before, so every marked chat made
-- before that moment was marked by the backfill. A marked chat made after it was created
-- by the app as a DM (agent page, agent questions), so a real back and forth in it is a
-- live DM and stays marked.
--
-- Among those backfilled chats, one is left alone when it is already clean: no messages,
-- or only the ones the app itself puts into a DM (the agent intro and its steps, a
-- proactive note from the agent). Deleted messages do not count.
--
-- Pairs that have a one-to-one chat but no DM at all also get one, so every pair has
-- exactly one marked chat. A pair with no chat yet gets its DM when it is first needed.
--
-- One DO block is one statement, so it commits or rolls back as a whole; the migration
-- runner executes statements one by one and re-runs an unrecorded file from the top.
-- Re-running it changes nothing: a clean marked chat is skipped and a pair with a
-- marked chat is skipped. The unique index on (workspace_id, direct_pair_key) and
-- ON CONFLICT DO NOTHING keep a DM created by the running app at the same moment from
-- failing the migration. No messages are read into, moved or deleted, and no events
-- are written. conversations is not on the hot-tables list (packages/db/MIGRATIONS.md)
-- and this touches one row per person and agent pair.
-- Rollback is drizzle/down/0142_clean_direct_messages_down.sql (a no-op by design).
DO $$
DECLARE
	r record;
	new_id uuid;
BEGIN
	-- 1. Backfilled chats that carry a real conversation: unmark, then open a fresh DM.
	FOR r IN
		SELECT
			c.id AS old_id,
			c.workspace_id,
			c.direct_pair_key AS pair_key,
			h.id AS human_id,
			ag.id AS agent_id,
			ag.name AS agent_name
		FROM "conversations" c
		JOIN "actors" h
			ON h.type = 'human'
			AND h.id::text IN (split_part(c.direct_pair_key, ':', 1), split_part(c.direct_pair_key, ':', 2))
		JOIN "actors" ag
			ON ag.type = 'agent'
			AND ag.id::text IN (split_part(c.direct_pair_key, ':', 1), split_part(c.direct_pair_key, ':', 2))
		WHERE c.direct_pair_key IS NOT NULL
			AND c.created_at < timestamptz '2026-10-29 20:31:58+00'
			AND EXISTS (
				SELECT 1 FROM "messages" m
				WHERE m.conversation_id = c.id
					AND m.deleted_at IS NULL
					AND COALESCE(m.metadata->'delivery'->>'kind', '')
						NOT IN ('agent_intro', 'agent_intro_steps', 'proactive')
			)
	LOOP
		UPDATE "conversations"
		SET "direct_pair_key" = NULL, "updated_at" = now()
		WHERE "id" = r.old_id;

		new_id := NULL;
		INSERT INTO "conversations" ("workspace_id", "title", "title_auto_state", "created_by", "direct_pair_key")
		VALUES (r.workspace_id, r.agent_name, 'none', r.human_id, r.pair_key)
		ON CONFLICT DO NOTHING
		RETURNING "id" INTO new_id;

		IF new_id IS NOT NULL THEN
			INSERT INTO "conversation_participants" ("conversation_id", "actor_id", "added_by")
			VALUES (new_id, r.human_id, r.human_id), (new_id, r.agent_id, r.human_id);
		END IF;
	END LOOP;

	-- 2. Pairs that have a one-to-one chat (exactly two active participants, one person and
	-- one agent, about no subject) but no DM: open one. Same pair test as the 0117 backfill.
	FOR r IN
		SELECT DISTINCT ON (pairs.workspace_id, pairs.pair_key)
			pairs.workspace_id, pairs.pair_key, pairs.human_id, pairs.agent_id, pairs.agent_name
		FROM (
			SELECT
				c2.workspace_id,
				LEAST(p1.actor_id, p2.actor_id)::text || ':' || GREATEST(p1.actor_id, p2.actor_id)::text AS pair_key,
				CASE WHEN a1.type = 'human' THEN a1.id ELSE a2.id END AS human_id,
				CASE WHEN a1.type = 'agent' THEN a1.id ELSE a2.id END AS agent_id,
				CASE WHEN a1.type = 'agent' THEN a1.name ELSE a2.name END AS agent_name
			FROM "conversations" c2
			JOIN "conversation_participants" p1
				ON p1.conversation_id = c2.id AND p1.left_at IS NULL
			JOIN "conversation_participants" p2
				ON p2.conversation_id = c2.id AND p2.left_at IS NULL AND p2.actor_id > p1.actor_id
			JOIN "actors" a1 ON a1.id = p1.actor_id
			JOIN "actors" a2 ON a2.id = p2.actor_id
			WHERE c2.subject_id IS NULL
				AND ((a1.type = 'human' AND a2.type = 'agent') OR (a1.type = 'agent' AND a2.type = 'human'))
				AND (
					SELECT count(*) FROM "conversation_participants" p
					WHERE p.conversation_id = c2.id AND p.left_at IS NULL
				) = 2
		) pairs
		WHERE NOT EXISTS (
			SELECT 1 FROM "conversations" d
			WHERE d.workspace_id = pairs.workspace_id AND d.direct_pair_key = pairs.pair_key
		)
		ORDER BY pairs.workspace_id, pairs.pair_key
	LOOP
		new_id := NULL;
		INSERT INTO "conversations" ("workspace_id", "title", "title_auto_state", "created_by", "direct_pair_key")
		VALUES (r.workspace_id, r.agent_name, 'none', r.human_id, r.pair_key)
		ON CONFLICT DO NOTHING
		RETURNING "id" INTO new_id;

		IF new_id IS NOT NULL THEN
			INSERT INTO "conversation_participants" ("conversation_id", "actor_id", "added_by")
			VALUES (new_id, r.human_id, r.human_id), (new_id, r.agent_id, r.human_id);
		END IF;
	END LOOP;
END $$;
