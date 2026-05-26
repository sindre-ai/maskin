-- Backfill api_key for every actor missing one, then enforce NOT NULL + UNIQUE.
--
-- Several actor-creation paths (Sindre seeded on workspace create / dev boot,
-- the demo seed agents, and the per-integration system actor) were inserting
-- rows without setting api_key. When those actors' containers later booted,
-- MASKIN_API_KEY was unset, the MCP Bearer token came through empty, and
-- writes either 401'd or — in environments where a fallback key was present in
-- the bootstrap environment — got authenticated as a different actor (usually
-- the workspace creator), silently misattributing every comment the agent
-- posted. See PR for the "actor_commenting_issue" branch.
--
-- This migration:
--   1) Generates an ank_-prefixed key for every existing row where it is null.
--   2) Adds UNIQUE so a future duplicate (e.g. a template clone) fails loudly
--      instead of silently picking up another actor via validateApiKey's
--      .limit(1).
--   3) Promotes api_key to NOT NULL so any future insert site that forgets to
--      set it fails at the DB layer rather than at runtime inside a container.

UPDATE actors
SET api_key = 'ank_' || replace(gen_random_uuid()::text, '-', '')
WHERE api_key IS NULL;

ALTER TABLE actors ADD CONSTRAINT actors_api_key_unique UNIQUE (api_key);

ALTER TABLE actors ALTER COLUMN api_key SET NOT NULL;
