-- comment_mentions: one row per person and entity that someone else's comment mentions.
--
-- GET /api/subscriptions/unread first lists the entities that can have an unread mention for the
-- caller, and did it by reading every `commented` event that mentions them: the mentions GIN index
-- finds the ids in milliseconds, but the table reads behind it took 3 s cold for one person (about
-- 10,500 comment rows to keep 548 entities), on every poll. Sentry MASKIN-DEV-35 and MASKIN-DEV-3A
-- fired again after the in-process list of PR 3745. This table holds the answer directly.
--
-- Filled by a trigger on `events`, so every comment is covered whichever code path writes it, and
-- an older server still running during a deploy fills it too. 0172 backfills the comments written
-- before this migration. The trigger exists before the backfill starts, so no comment falls between
-- the two; both use ON CONFLICT DO NOTHING, so overlap and re-runs are harmless.
--
-- Same rule as the query it replaces: a comment by someone other than the mentioned person, with
-- the person's id in data.mentions. Mentions come from the request body, so an entry can be any
-- text: only well-formed uuids are kept (the cast sits in a CASE, because SQL does not promise to
-- run a WHERE filter before a cast), and a data.mentions that is not an array is ignored. The
-- trigger must never fail a comment insert. actor_id and entity_id have no foreign keys: a mention
-- can name an actor that was deleted, and entities are not only objects.
--
-- A comment's mentions are fixed when it is written, so rows are never removed except with the
-- workspace (ON DELETE CASCADE). The unread query still decides what counts as unread.
--
-- Locking: CREATE TABLE is new and empty. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `events` for
-- an instant; it waits for writers that are mid-transaction, and writers queue behind it while it
-- waits, so it runs in a DO block with a 5 s lock_timeout (SET LOCAL only works inside a block):
-- if `events` is busy the migration fails fast and can be re-run. The trigger only fires for
-- `commented` rows (WHEN clause); every other event pays nothing.
-- Row-level security is on because 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0171_comment_mentions_down.sql.
CREATE TABLE IF NOT EXISTS "comment_mentions" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	PRIMARY KEY ("workspace_id", "actor_id", "entity_id")
);
--> statement-breakpoint
ALTER TABLE "comment_mentions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION comment_mentions_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO comment_mentions (workspace_id, actor_id, entity_id)
	SELECT NEW.workspace_id, m.actor_id, NEW.entity_id
	FROM (
		SELECT CASE
			WHEN t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t::uuid
		END AS actor_id
		FROM jsonb_array_elements_text(
			CASE WHEN jsonb_typeof(NEW.data -> 'mentions') = 'array'
				THEN NEW.data -> 'mentions' ELSE '[]'::jsonb END
		) AS t
	) AS m
	WHERE m.actor_id IS NOT NULL AND m.actor_id <> NEW.actor_id
	ON CONFLICT DO NOTHING;
	RETURN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	SET LOCAL lock_timeout = '5s';
	CREATE OR REPLACE TRIGGER "events_comment_mentions"
		AFTER INSERT ON "events"
		FOR EACH ROW WHEN (NEW.action = 'commented')
		EXECUTE FUNCTION comment_mentions_record();
END $$;
