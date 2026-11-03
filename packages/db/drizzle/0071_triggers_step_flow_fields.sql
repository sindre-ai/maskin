-- D6a: extend `triggers` with three nullable columns the Loops v4 vertical-
-- story renderer (D6c) and the escalation reconciler (D6b) both read from.
--
-- The `triggers` row IS the loop step in this codebase: a Loop object stores
-- an ordered list of step ids in `metadata.trigger_ids`, and every step's
-- name / prompt / target agent already lives on the triggers row. Extending
-- `triggers` in place — rather than minting a new `loop_step` table — matches
-- ADR-005 ("no new tables for shape extensions") and the SPEC Q2 Option A
-- decision (Architect + Magnus, 2026-09-03).
--
-- All three columns are nullable; existing rows read NULL on all three, so the
-- vertical-story renderer omits the HANDS OFF and ESCALATES TO rows for any
-- step that hasn't opted in. This is the expand slice — no consumer code
-- reads the fields yet; the dormant migration ships alone so D6b and D6c can
-- PR-stack on this branch (bet body + task 3).
--
-- `triggers` is NOT on the hot-tables list in packages/db/MIGRATIONS.md, so
-- plain `ADD COLUMN` is safe: nullable columns without defaults are a metadata-
-- only change in Postgres and take no table rewrite. Kept in one statement per
-- ADD COLUMN so a partial failure doesn't leave a mixed state (the migrator
-- runs each simple-query message on its own, not inside an implicit BEGIN).

ALTER TABLE "triggers" ADD COLUMN "hands_off_to_actor_id" uuid REFERENCES "actors"("id");
--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "escalates_to_actor_id" uuid REFERENCES "actors"("id");
--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "escalate_after_ms" integer;
