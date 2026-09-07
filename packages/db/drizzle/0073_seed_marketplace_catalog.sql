-- Seeds the global (workspace_id IS NULL) marketplace catalog with the
-- initial superset of Maskin-curated loops, agents, and skills. Per
-- Marketplace tech spec §7, this is v1's admin curation path — the TS
-- manifest at packages/shared/src/templates/marketplace-catalog.ts is the
-- source of truth for what SHOULD be in the catalog; this migration is the
-- one-shot bootstrap that reifies that manifest as global rows. Subsequent
-- curation changes ship as NEW migration files, not by editing this one.
--
-- IDEMPOTENCY (asserted by seed-reify.test.ts per §9.1): every INSERT here
-- uses ON CONFLICT DO UPDATE keyed on (slug) for marketplace_loops (which
-- has a global-slug UNIQUE constraint) and on (slug) WHERE workspace_id IS
-- NULL for marketplace_agents and marketplace_skills (their existing
-- (workspace_id, slug) unique index uses NULLS DISTINCT so two NULL-
-- workspace rows would be treated as unrelated — the partial index below
-- fixes that for the global-catalog use case without touching the sibling
-- workspace-private path).
--
-- DENORMALIZED COUNTERS: `install_count` is deliberately NOT overwritten by
-- the ON CONFLICT UPDATE. Re-running this migration must preserve counter
-- state; only the manifest-authored curator fields refresh.
--
-- SUPERSET GUARANTEE (§7): every DEFAULT_WORKSPACE_LOOPS / AGENTS / SKILLS
-- $id from packages/shared/src/templates/default-workspace-agents.ts is
-- represented here (slugs kebab-cased). marketplace-seed-overlap.test.ts
-- pins that guarantee.

-- ── Partial unique indexes for global catalog rows ────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_agents_global_slug_uniq"
	ON "marketplace_agents" ("slug") WHERE "workspace_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_skills_global_slug_uniq"
	ON "marketplace_skills" ("slug") WHERE "workspace_id" IS NULL;
--> statement-breakpoint

-- ── Loops ─────────────────────────────────────────────────────────────────
INSERT INTO "marketplace_loops"
	(slug, name, description, version, use_case, team, recommendation, requires, status, sort_weight)
VALUES
	(
		'discovery-bet',
		'Bet discovery loop',
		$$Turns raw insights into shaped Shape Up bets. Signal Analyst triages new insights immediately and runs a daily/weekly clustering sweep; a human promotes to `define`; Strategist shapes the pitch. Closes when the bet leaves `define`.$$,
		'1.0.0',
		'Insight triage and bet shaping',
		'product',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		100
	),
	(
		'workspace-improvements',
		'Workspace improvements',
		$$Turns Workspace Coach coaching signals into clustered, actionable recommendations for the human. Coach files `[workspace-improvements]` insights, Chief of Staff clusters daily by theme and posts one consolidated recommendation.$$,
		'1.0.0',
		'Workspace observability and coaching',
		'shared',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		60
	),
	(
		'knowledge-wiki-digest',
		'Knowledge Wiki digest',
		$$Maintains the human-facing knowledge wiki and publishes a twice-weekly digest of what changed. Knowledge Curator folds new knowledge objects into the graph and compiles the recap.$$,
		'1.0.0',
		'Knowledge management',
		'shared',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		40
	)
ON CONFLICT (slug) DO UPDATE SET
	name           = EXCLUDED.name,
	description    = EXCLUDED.description,
	version        = EXCLUDED.version,
	use_case       = EXCLUDED.use_case,
	team           = EXCLUDED.team,
	recommendation = EXCLUDED.recommendation,
	requires       = EXCLUDED.requires,
	status         = EXCLUDED.status,
	sort_weight    = EXCLUDED.sort_weight,
	updated_at     = now();
--> statement-breakpoint

-- ── Agents ────────────────────────────────────────────────────────────────
-- system_prompt here is a short marker; the full workspace-seed prompt lives
-- in packages/shared/src/templates/default-workspace-agents.ts and is what
-- workspace-bootstrap.ts materializes for each new workspace. Seeded agents
-- reach the workspace via bootstrap (not via the marketplace install path),
-- so this column serves discovery / detail-page rendering rather than the
-- install-time actor.system_prompt copy.
INSERT INTO "marketplace_agents"
	(workspace_id, slug, display_name, outcome_line, description, system_prompt, skill_slugs, trigger_seeds, team, recommendation, requires, status, sort_weight)
VALUES
	(
		NULL,
		'driver',
		'Driver',
		'Keeps tasks and bets moving — re-kicks failed sessions and fills missing drivers.',
		$$Operational sweep agent. Daily pass over the `todo` column: assigns missing drivers, re-kicks stuck sessions once, escalates repeat failures with a specific diagnosis. Bias toward action over observation; silent when things are working.$$,
		'See DEFAULT_WORKSPACE_AGENTS[driver] in packages/shared/src/templates/default-workspace-agents.ts for the full system prompt used by workspace bootstrap.',
		'["maskin-way-of-working"]'::jsonb,
		'[]'::jsonb,
		'shared',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		100
	),
	(
		NULL,
		'strategist',
		'Strategist',
		'Shapes define-stage bets into falsifiable Shape Up specs.',
		$$Sole owner of the shaping phase. Takes bets in `define`, drafts a Shape Up pitch with appetite, success criteria, breadboard, and rabbit-hole notes, and routes load-bearing unknowns to the right mandatory-catch role before promoting to `active`.$$,
		'See DEFAULT_WORKSPACE_AGENTS[strategist] in packages/shared/src/templates/default-workspace-agents.ts for the full system prompt.',
		'["shaped-bet-format", "maskin-way-of-working"]'::jsonb,
		'[]'::jsonb,
		'product',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		95
	),
	(
		NULL,
		'signal-analyst',
		'Signal Analyst',
		'Clusters raw insight signal into candidate bets and stages them for shaping.',
		$$First half of the bet discovery loop. Triages new insights immediately, runs a daily clustering sweep, and re-validates the `signal`-bet inventory weekly. Stages one candidate bet per real cluster.$$,
		'See DEFAULT_WORKSPACE_AGENTS[signal_analyst] in packages/shared/src/templates/default-workspace-agents.ts.',
		'[]'::jsonb,
		'[]'::jsonb,
		'product',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		80
	),
	(
		NULL,
		'researcher',
		'Researcher',
		'Supplies source-backed briefs and files insights for the discovery loop.',
		$$Files insight objects from external sources and internal signals with citation trails Signal Analyst can cluster. Answers targeted research asks from Strategist and other agents mid-shaping.$$,
		'See DEFAULT_WORKSPACE_AGENTS[researcher] in packages/shared/src/templates/default-workspace-agents.ts.',
		'[]'::jsonb,
		'[]'::jsonb,
		'shared',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		70
	),
	(
		NULL,
		'knowledge-curator',
		'Knowledge Curator',
		'Maintains the human-facing knowledge wiki and publishes the twice-weekly digest.',
		$$Folds new knowledge objects into the graph, wires supersedes/contradicts lineage, keeps the curated Homepage and Status pages fresh, and compiles the human-readable digest on cadence.$$,
		'See DEFAULT_WORKSPACE_AGENTS[knowledge_curator] in packages/shared/src/templates/default-workspace-agents.ts.',
		'[]'::jsonb,
		'[]'::jsonb,
		'shared',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		50
	)
ON CONFLICT (slug) WHERE workspace_id IS NULL DO UPDATE SET
	display_name   = EXCLUDED.display_name,
	outcome_line   = EXCLUDED.outcome_line,
	description    = EXCLUDED.description,
	system_prompt  = EXCLUDED.system_prompt,
	skill_slugs    = EXCLUDED.skill_slugs,
	trigger_seeds  = EXCLUDED.trigger_seeds,
	team           = EXCLUDED.team,
	recommendation = EXCLUDED.recommendation,
	requires       = EXCLUDED.requires,
	status         = EXCLUDED.status,
	sort_weight    = EXCLUDED.sort_weight,
	updated_at     = now();
--> statement-breakpoint

-- ── Skills ────────────────────────────────────────────────────────────────
INSERT INTO "marketplace_skills"
	(workspace_id, slug, display_name, outcome_line, description, content, team, recommendation, requires, status, sort_weight)
VALUES
	(
		NULL,
		'for-you-format',
		'For You format',
		'Mandatory format for anything landing in the human For You queue.',
		$$One decision per item; never write when nothing is blocked. Attach to any agent that routinely escalates so the human queue reads as a set of decisions, not a status log.$$,
		$$---
name: for-you-format
description: The mandatory format for items in the human For You queue.
---

Full skill body lives in packages/shared/src/templates/default-workspace-agents.ts (FOR_YOU_FORMAT_SKILL). This marketplace row is the discovery / detail-page projection; install pulls the source content from the seed manifest.
$$,
		'shared',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		90
	),
	(
		NULL,
		'shaped-bet-format',
		'Shaped bet format',
		'The Shape Up format Strategist uses when a `define`-stage bet is ready to hand to Planner.',
		$$Structured pitch: pitch summary, appetite, success criteria (won / lost / inconclusive), solution sketch, rabbit-hole notes, and no-goes. Attach to Strategist and to any agent writing shaped bets.$$,
		$$---
name: shaped-bet-format
description: The Shape Up format for shaped bets ready to move to `active`.
---

Full skill body lives in packages/shared/src/templates/default-workspace-agents.ts (SHAPED_BET_FORMAT_SKILL).
$$,
		'product',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		80
	),
	(
		NULL,
		'maskin-way-of-working',
		'Maskin way of working',
		'The workspace-wide conventions every agent should follow.',
		$$Rendering rules, mention conventions, attention-score guidance, and the general house-style for agents operating in Maskin workspaces. Attach broadly.$$,
		$$---
name: maskin-way-of-working
description: Workspace-wide conventions and house style for Maskin agents.
---

Full skill body lives in packages/shared/src/templates/default-workspace-agents.ts (MASKIN_WAY_OF_WORKING_SKILL).
$$,
		'shared',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		75
	),
	(
		NULL,
		'continuous-onboarding',
		'Continuous onboarding',
		'The onboarding format Chief of Staff runs to bring a new workspace human up to speed.',
		$$Sequenced prompts + escalations that keep onboarding moving without dumping everything on day one. Owned by Chief of Staff; attach to any agent that runs onboarding-flavored work.$$,
		$$---
name: continuous-onboarding
description: The Chief-of-Staff-owned onboarding sequence for new workspace humans.
---

Full skill body lives in packages/shared/src/templates/default-workspace-agents.ts (CONTINUOUS_ONBOARDING_SKILL).
$$,
		'customer',
		'{}'::jsonb,
		'{}'::jsonb,
		'published',
		60
	)
ON CONFLICT (slug) WHERE workspace_id IS NULL DO UPDATE SET
	display_name   = EXCLUDED.display_name,
	outcome_line   = EXCLUDED.outcome_line,
	description    = EXCLUDED.description,
	content        = EXCLUDED.content,
	team           = EXCLUDED.team,
	recommendation = EXCLUDED.recommendation,
	requires       = EXCLUDED.requires,
	status         = EXCLUDED.status,
	sort_weight    = EXCLUDED.sort_weight,
	updated_at     = now();
