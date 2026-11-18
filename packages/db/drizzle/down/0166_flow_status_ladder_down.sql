-- Rollback for 0166_flow_status_ladder.sql. Puts the old names back: pilot becomes learning and
-- live becomes fully_autonomous, and the workspace status lists go back to the old five names.
-- It cannot tell which supervised flows were draft flows with running triggers, so those stay
-- supervised, which is what they were running as. Roll back the code that reads the new names
-- first, and note that a flow that was written as pilot or live before the migration also comes
-- back as learning or fully_autonomous.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

UPDATE objects SET status = 'learning' WHERE type = 'loop' AND status = 'pilot';
--> statement-breakpoint
UPDATE objects SET status = 'fully_autonomous' WHERE type = 'loop' AND status = 'live';
--> statement-breakpoint
UPDATE workspaces
SET settings = jsonb_set(
	settings,
	'{statuses,loop}',
	'["draft","paused","learning","supervised","fully_autonomous"]'::jsonb
)
WHERE jsonb_typeof(settings->'statuses'->'loop') = 'array'
	AND settings->'statuses'->'loop' @> '["pilot"]'::jsonb;
