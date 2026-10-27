-- Rollback for 0113. Renames the bet status `opportunity` back to `signal`.
--
-- Covers the structured data only: bet rows, settings.statuses.bet and trigger configs.
-- Prompt text (actors, triggers, workspace skills) is NOT restored — the up migration
-- rewrites only status-shaped references, and `opportunity` is not distinguishable from
-- text a person wrote later, so a blind reverse would damage newer edits. Roll the code
-- back to the previous release and its templates, and restore prompts from a backup if
-- they must be reverted.
--
-- Bets created as `opportunity` after 0113 are moved back too.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

UPDATE "objects" SET "status" = 'signal', "updated_at" = now()
WHERE "type" = 'bet' AND "status" = 'opportunity';
--> statement-breakpoint
UPDATE "workspaces"
SET "settings" = jsonb_set(
	"settings",
	'{statuses,bet}',
	(
		SELECT coalesce(jsonb_agg(CASE WHEN s = '"opportunity"'::jsonb THEN '"signal"'::jsonb ELSE s END ORDER BY pos), '[]'::jsonb)
		FROM jsonb_array_elements("settings"->'statuses'->'bet') WITH ORDINALITY AS t(s, pos)
	)
)
WHERE jsonb_typeof("settings"->'statuses'->'bet') = 'array'
	AND "settings"->'statuses'->'bet' @> '["opportunity"]'::jsonb;
--> statement-breakpoint
UPDATE "triggers"
SET "config" = regexp_replace("config"::text, '(?<!\\)"opportunity"', '"signal"', 'g')::jsonb
WHERE "config"::text ~ '"opportunity"';
