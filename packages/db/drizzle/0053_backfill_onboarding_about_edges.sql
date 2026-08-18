-- Backfill for the ratified user-info home decision (2026-06-23):
--   every knowledge row captured by workspace-observer-onboarding must carry
--   an `about` edge — to the workspace owner's actor for owner-targeted
--   prompts (product_vision, icp, first_bet_hypothesis, customer_evidence),
--   and to the workspace for north_star_metric.
--
-- This migration runs BEFORE the skill is flipped to the new write path
-- (single create_objects with knowledge + about edge in one transaction), so
-- no owner-targeted row exists in the "new state" without its edge — the
-- pre-flip inventory is fixed here, the post-flip writes are correct by
-- construction.
--
-- Scope: identifies onboarding-authored knowledge rows via their existing
-- `relates_to` edge to a `type = 'onboarding_session'` object (the T4 skill
-- always writes that edge). For each, resolves the workspace owner, derives
-- the prompt from the knowledge title (case-insensitive), and:
--   1. inserts the missing `about` edge (idempotent on the src/tgt/type
--      unique index — a rerun of the migration or an overlap with the new
--      write path is a no-op).
--   2. stamps metadata.source = 'workspace_onboarding', subject_kind,
--      subject_id and prompt_key if they aren't already set (preserving
--      existing keys via the `||` jsonb merge).
--   3. backfills workspace_onboarding_prompts.object_id where blank so the
--      (workspace, prompt) → knowledge link is queryable without walking
--      relationships.
--
-- Not chunked: none of the touched tables (`relationships`, `objects`,
-- `workspace_onboarding_prompts`) are on the hot-tables list in
-- packages/db/MIGRATIONS.md, and the working set is bounded by the number
-- of onboarding sessions that actually ran under the flag — measured in
-- tens, not millions. If that ever changes, chunk per Rule 2 there.
--
-- Note on `target_type`: the CHECK constraint on `relationships` (added in
-- 0046) requires `source_type` and `target_type` in ('object', 'file').
-- Actor and workspace UUIDs are inserted with `target_type = 'object'`,
-- matching how apps/dev/src/routes/graph.ts stamps every non-file endpoint.
-- The ratified decision names the edge conceptually as
-- `knowledge --about--> actor` / `knowledge --about--> workspace`; the
-- storage-layer label stays loose because typed actor/workspace edge
-- categories are out of scope for this task. Downstream readers of these
-- edges must look up the target UUID against `actors` / `workspaces` to
-- disambiguate.

-- Step 1: insert the missing `about` edges.
INSERT INTO relationships (source_type, source_id, target_type, target_id, type, created_by)
SELECT
	'object',
	t.knowledge_id,
	'object',
	t.subject_id,
	'about',
	t.created_by
FROM (
	SELECT
		k.id            AS knowledge_id,
		k.workspace_id  AS workspace_id,
		COALESCE(k.created_by, (
			SELECT wm.actor_id
			FROM workspace_members wm
			WHERE wm.workspace_id = k.workspace_id
				AND wm.role = 'owner'
			ORDER BY wm.joined_at NULLS LAST
			LIMIT 1
		)) AS created_by,
		CASE
			WHEN lower(k.title) LIKE 'north star metric%'
				OR lower(k.title) LIKE 'north-star metric%' THEN k.workspace_id
			ELSE (
				SELECT wm.actor_id
				FROM workspace_members wm
				WHERE wm.workspace_id = k.workspace_id
					AND wm.role = 'owner'
				ORDER BY wm.joined_at NULLS LAST
				LIMIT 1
			)
		END AS subject_id
	FROM objects k
	WHERE k.type = 'knowledge'
		AND EXISTS (
			SELECT 1
			FROM relationships r
			JOIN objects s ON s.id = r.target_id
			WHERE r.source_id = k.id
				AND r.type = 'relates_to'
				AND s.type = 'onboarding_session'
		)
		AND (
			lower(k.title) LIKE 'product vision%'
			OR lower(k.title) LIKE 'icp%'
			OR lower(k.title) LIKE 'first-bet hypothesis%'
			OR lower(k.title) LIKE 'first bet hypothesis%'
			OR lower(k.title) LIKE 'first bet%'
			OR lower(k.title) LIKE 'north star metric%'
			OR lower(k.title) LIKE 'north-star metric%'
			OR lower(k.title) LIKE 'customer evidence%'
		)
) t
WHERE t.subject_id IS NOT NULL
	AND t.created_by IS NOT NULL
ON CONFLICT (source_id, target_id, type) DO NOTHING;
--> statement-breakpoint

-- Step 2: stamp metadata.source / subject_kind / subject_id / prompt_key.
-- Preserves any existing metadata keys via the `||` jsonb merge (right-hand
-- keys win, so a rerun with different casing/spelling stays deterministic).
UPDATE objects o
SET metadata = COALESCE(o.metadata, '{}'::jsonb) || jsonb_build_object(
	'source', 'workspace_onboarding',
	'prompt_key', t.prompt_key,
	'subject_kind', t.subject_kind,
	'subject_id', t.subject_id::text
)
FROM (
	SELECT
		k.id AS knowledge_id,
		CASE
			WHEN lower(k.title) LIKE 'product vision%' THEN 'product_vision'
			WHEN lower(k.title) LIKE 'icp%' THEN 'icp'
			WHEN lower(k.title) LIKE 'first-bet hypothesis%'
				OR lower(k.title) LIKE 'first bet hypothesis%'
				OR lower(k.title) LIKE 'first bet%' THEN 'first_bet_hypothesis'
			WHEN lower(k.title) LIKE 'north star metric%'
				OR lower(k.title) LIKE 'north-star metric%' THEN 'north_star_metric'
			WHEN lower(k.title) LIKE 'customer evidence%' THEN 'customer_evidence'
			ELSE NULL
		END AS prompt_key,
		CASE
			WHEN lower(k.title) LIKE 'north star metric%'
				OR lower(k.title) LIKE 'north-star metric%' THEN 'workspace'
			ELSE 'workspace_owner'
		END AS subject_kind,
		CASE
			WHEN lower(k.title) LIKE 'north star metric%'
				OR lower(k.title) LIKE 'north-star metric%' THEN k.workspace_id
			ELSE (
				SELECT wm.actor_id
				FROM workspace_members wm
				WHERE wm.workspace_id = k.workspace_id
					AND wm.role = 'owner'
				ORDER BY wm.joined_at NULLS LAST
				LIMIT 1
			)
		END AS subject_id
	FROM objects k
	WHERE k.type = 'knowledge'
		AND EXISTS (
			SELECT 1
			FROM relationships r
			JOIN objects s ON s.id = r.target_id
			WHERE r.source_id = k.id
				AND r.type = 'relates_to'
				AND s.type = 'onboarding_session'
		)
) t
WHERE o.id = t.knowledge_id
	AND t.prompt_key IS NOT NULL
	AND t.subject_id IS NOT NULL
	AND (
		COALESCE(o.metadata->>'source', '') <> 'workspace_onboarding'
		OR COALESCE(o.metadata->>'subject_kind', '') = ''
		OR COALESCE(o.metadata->>'subject_id', '') = ''
		OR COALESCE(o.metadata->>'prompt_key', '') = ''
	);
--> statement-breakpoint

-- Step 3: backfill workspace_onboarding_prompts.object_id so the
-- (workspace, prompt) → knowledge lookup does not have to walk edges.
UPDATE workspace_onboarding_prompts p
SET object_id = t.knowledge_id
FROM (
	SELECT
		k.id           AS knowledge_id,
		k.workspace_id AS workspace_id,
		CASE
			WHEN lower(k.title) LIKE 'product vision%' THEN 'product_vision'
			WHEN lower(k.title) LIKE 'icp%' THEN 'icp'
			WHEN lower(k.title) LIKE 'first-bet hypothesis%'
				OR lower(k.title) LIKE 'first bet hypothesis%'
				OR lower(k.title) LIKE 'first bet%' THEN 'first_bet_hypothesis'
			WHEN lower(k.title) LIKE 'north star metric%'
				OR lower(k.title) LIKE 'north-star metric%' THEN 'north_star_metric'
			WHEN lower(k.title) LIKE 'customer evidence%' THEN 'customer_evidence'
			ELSE NULL
		END AS prompt_key
	FROM objects k
	WHERE k.type = 'knowledge'
		AND EXISTS (
			SELECT 1
			FROM relationships r
			JOIN objects s ON s.id = r.target_id
			WHERE r.source_id = k.id
				AND r.type = 'relates_to'
				AND s.type = 'onboarding_session'
		)
) t
WHERE p.workspace_id = t.workspace_id
	AND p.prompt_type = t.prompt_key
	AND p.object_id IS NULL
	AND t.prompt_key IS NOT NULL;
