-- Re-point agents that still carry the leaked Exa key to the env var placeholder.
--
-- The default-workspace seed used to write a literal Exa key into every seeded
-- agent's actors.tools.mcpServers.exa.headers['x-api-key']. That key was public
-- in git, so it is being rotated. New workspaces already get the placeholder;
-- this rewrites the rows seeded before that.
--
-- A row is touched only when the sha256 of its header value equals the digest
-- of the leaked key. The key itself is deliberately not in this file (the repo
-- is public); a customer's own Exa key hashes differently and is left alone.
-- Rows already on a placeholder do not match either, so a second run changes 0
-- rows.
--
-- Besides the header, tools.envFrom gets AGENT_SECRET_EXA_API_KEY appended
-- (resolveActorSecretEnv only copies AGENT_SECRET_* names into a session).
-- Every other field of tools is left as is.
--
-- Deploy ordering: AGENT_SECRET_EXA_API_KEY must be set on the API service
-- before this runs, otherwise migrated agents send an empty Exa header until it
-- is set. actors is not a hot table (packages/db/MIGRATIONS.md) and the
-- statement is bounded by the digest predicate, so no chunking.
--
-- No down migration: restoring the old key would need the key in this repo.
UPDATE "actors"
SET "tools" = jsonb_set(
	jsonb_set(
		"tools",
		'{mcpServers,exa,headers,x-api-key}',
		to_jsonb('${AGENT_SECRET_EXA_API_KEY}'::text)
	),
	'{envFrom}',
	CASE
		WHEN jsonb_typeof("tools"->'envFrom') = 'array'
			THEN CASE
				WHEN "tools"->'envFrom' @> to_jsonb('AGENT_SECRET_EXA_API_KEY'::text)
					THEN "tools"->'envFrom'
				ELSE "tools"->'envFrom' || to_jsonb('AGENT_SECRET_EXA_API_KEY'::text)
			END
		ELSE jsonb_build_array('AGENT_SECRET_EXA_API_KEY')
	END
)
WHERE jsonb_typeof("tools"->'mcpServers'->'exa'->'headers'->'x-api-key') = 'string'
	AND encode(
		sha256(convert_to("tools"->'mcpServers'->'exa'->'headers'->>'x-api-key', 'UTF8')),
		'hex'
	) = 'aee8644fa0a647033dc5299ff0abd0a402cd77b4392ac60c58d506621ab0eeee';
