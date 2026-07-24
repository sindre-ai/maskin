-- T2 of `bet/tiptap-editor`: add optimistic concurrency to the objects table so
-- concurrent human + agent writes on the same row surface a 409 to the loser
-- instead of silently overwriting the winner. Backs the "content changed
-- underneath you" reconcile banner T4 renders.
--
-- Applied Recipe 3 (state-predicated WHERE) from the claim-first idiom knowledge
-- article: the PATCH handler adds `AND version = ?` to its UPDATE so the guard
-- runs in the same statement the write does, no SELECT-then-UPDATE race.
--
-- Column: `version integer NOT NULL DEFAULT 1`. Postgres 11+ stores a constant
-- default in pg_attribute so ADD COLUMN does NOT rewrite the table — the
-- backfill for existing rows is instant. Trigger: `bump_objects_version` fires
-- BEFORE UPDATE FOR EACH ROW and unconditionally sets `NEW.version = OLD.version + 1`.
-- Doing the bump in the trigger means every write path (`session-manager`,
-- `slack/interactive`, `trigger-runner`, `actors`, `installed-packages`,
-- `catalog-packages`, `package-version-pusher`, the objects route itself)
-- increments the version without each call site having to opt in. Callers that
-- try to SET version explicitly are overridden by the trigger — the version
-- number is entirely owned by the database.

ALTER TABLE "objects"
	ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION bump_objects_version() RETURNS trigger AS $$
BEGIN
	NEW.version := OLD.version + 1;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER objects_bump_version
	BEFORE UPDATE ON "objects"
	FOR EACH ROW
	EXECUTE FUNCTION bump_objects_version();
