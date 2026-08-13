-- Persists one row per `reviewer_verdict_submitted` event fired by Stage 2 of
-- the single-prompt agent builder (see bet: agent-builder). The reviewer (T6)
-- writes `verdict` + `criteria_verdicts`; a human or non-reviewer agent later
-- sets `human_agreed` + optional `human_criteria_disagreements` so precision
-- (agreed / rated) can be computed per rubric object. The route layer
-- additionally forbids `human_rated_by = reviewer_actor_id`.
--
-- `criteria_verdicts` is the full array T6 returns per verdict —
-- `[{ name, pass, fix? }]` — kept as JSONB so future criteria mutations don't
-- need a schema migration. `human_criteria_disagreements` is a string[] of
-- criterion names the human explicitly flagged as false-positive: it lets
-- DoD 5 comment name the specific rubric criteria producing false positives
-- when precision < 70%.

CREATE TABLE IF NOT EXISTS "reviewer_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rubric_id" uuid NOT NULL,
	"target_actor_id" uuid NOT NULL,
	"reviewer_actor_id" uuid NOT NULL,
	"reviewer_session_id" uuid,
	"cycle_number" integer NOT NULL DEFAULT 0,
	"verdict" text NOT NULL,
	"criteria_verdicts" jsonb NOT NULL,
	"human_agreed" boolean,
	"human_criteria_disagreements" jsonb,
	"human_rated_by" uuid,
	"human_rated_at" timestamp with time zone,
	"human_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewer_verdicts_verdict_check" CHECK ("verdict" IN ('pass', 'fail')),
	CONSTRAINT "reviewer_verdicts_rating_pair_check" CHECK (
		("human_agreed" IS NULL AND "human_rated_by" IS NULL AND "human_rated_at" IS NULL)
		OR ("human_agreed" IS NOT NULL AND "human_rated_by" IS NOT NULL AND "human_rated_at" IS NOT NULL)
	)
);

ALTER TABLE "reviewer_verdicts"
	DROP CONSTRAINT IF EXISTS "reviewer_verdicts_workspace_id_workspaces_id_fk";
ALTER TABLE "reviewer_verdicts"
	ADD CONSTRAINT "reviewer_verdicts_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE no action ON UPDATE no action;

ALTER TABLE "reviewer_verdicts"
	DROP CONSTRAINT IF EXISTS "reviewer_verdicts_rubric_id_objects_id_fk";
ALTER TABLE "reviewer_verdicts"
	ADD CONSTRAINT "reviewer_verdicts_rubric_id_objects_id_fk"
	FOREIGN KEY ("rubric_id") REFERENCES "public"."objects"("id")
	ON DELETE no action ON UPDATE no action;

ALTER TABLE "reviewer_verdicts"
	DROP CONSTRAINT IF EXISTS "reviewer_verdicts_target_actor_id_actors_id_fk";
ALTER TABLE "reviewer_verdicts"
	ADD CONSTRAINT "reviewer_verdicts_target_actor_id_actors_id_fk"
	FOREIGN KEY ("target_actor_id") REFERENCES "public"."actors"("id")
	ON DELETE no action ON UPDATE no action;

ALTER TABLE "reviewer_verdicts"
	DROP CONSTRAINT IF EXISTS "reviewer_verdicts_reviewer_actor_id_actors_id_fk";
ALTER TABLE "reviewer_verdicts"
	ADD CONSTRAINT "reviewer_verdicts_reviewer_actor_id_actors_id_fk"
	FOREIGN KEY ("reviewer_actor_id") REFERENCES "public"."actors"("id")
	ON DELETE no action ON UPDATE no action;

ALTER TABLE "reviewer_verdicts"
	DROP CONSTRAINT IF EXISTS "reviewer_verdicts_human_rated_by_actors_id_fk";
ALTER TABLE "reviewer_verdicts"
	ADD CONSTRAINT "reviewer_verdicts_human_rated_by_actors_id_fk"
	FOREIGN KEY ("human_rated_by") REFERENCES "public"."actors"("id")
	ON DELETE no action ON UPDATE no action;

ALTER TABLE "reviewer_verdicts"
	DROP CONSTRAINT IF EXISTS "reviewer_verdicts_created_by_actors_id_fk";
ALTER TABLE "reviewer_verdicts"
	ADD CONSTRAINT "reviewer_verdicts_created_by_actors_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id")
	ON DELETE no action ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "reviewer_verdicts_ws_rubric_idx"
	ON "reviewer_verdicts" ("workspace_id", "rubric_id");
CREATE INDEX IF NOT EXISTS "reviewer_verdicts_ws_created_idx"
	ON "reviewer_verdicts" ("workspace_id", "created_at");
