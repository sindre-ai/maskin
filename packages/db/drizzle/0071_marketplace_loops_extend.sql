-- Extends marketplace_loops with the five remaining columns from
-- Marketplace tech spec §2.2 (the sibling `requires` column already landed
-- via migration 0067). `team` is the taxonomy filter behind the `By team`
-- rail (§5.1); `recommendation` is the rule bundle the recommendation-
-- engine evaluates per request (§4.1); `status`, `sort_weight`, and
-- `install_count` power curation and ordering on the catalog list.
--
-- `team` defaults to 'shared' per §2.4 backfill — the seed reify migration
-- (§7, migration 0073) sets the real team for each catalog entry. The
-- (team, status) index mirrors the sibling `marketplace_agents_team_status_
-- idx` shipped by 0068 so the tab-filter read pattern is symmetric across
-- catalog tables.
ALTER TABLE "marketplace_loops"
	ADD COLUMN IF NOT EXISTS "team" text NOT NULL DEFAULT 'shared',
	ADD COLUMN IF NOT EXISTS "recommendation" jsonb NOT NULL DEFAULT '{}'::jsonb,
	ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'published',
	ADD COLUMN IF NOT EXISTS "sort_weight" integer NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS "install_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_loops_team_status_idx"
	ON "marketplace_loops" ("team", "status");
