-- Remove Exa from every agent's tools.
--
-- We no longer use Exa. The templates stopped shipping it in #2242, but agents seeded before
-- that still carry tools.mcpServers.exa (on older rows with the leaked key written into the
-- header) and AGENT_SECRET_EXA_API_KEY in tools.envFrom. This drops both. Every other field of
-- tools, and every other mcpServers and envFrom entry, is left as is.
--
-- Idempotent: the WHERE only matches rows that still have one of the two, so a second run
-- changes 0 rows. actors is not a hot table (packages/db/MIGRATIONS.md), so no chunking.
--
-- No down migration: putting Exa back would bring back a tool we no longer use.
UPDATE "actors"
SET "tools" = CASE
	WHEN jsonb_typeof("tools"->'envFrom') = 'array'
		THEN jsonb_set(
			"tools" #- '{mcpServers,exa}',
			'{envFrom}',
			COALESCE(
				(
					SELECT jsonb_agg(e.value ORDER BY e.ordinality)
					FROM jsonb_array_elements("tools"->'envFrom') WITH ORDINALITY AS e(value, ordinality)
					WHERE e.value <> to_jsonb('AGENT_SECRET_EXA_API_KEY'::text)
				),
				'[]'::jsonb
			)
		)
	ELSE "tools" #- '{mcpServers,exa}'
END
WHERE jsonb_typeof("tools"->'mcpServers'->'exa') IS NOT NULL
	OR (
		jsonb_typeof("tools"->'envFrom') = 'array'
		AND "tools"->'envFrom' @> jsonb_build_array('AGENT_SECRET_EXA_API_KEY')
	);
