-- The Objects page now opens as a flat list (group by "none") instead of grouped by State.
--
-- Changing the default in the route only reaches people with no saved view. Everyone who
-- opened the page before already has a user_display_settings row with groupBy = 'status',
-- written by the old default, and that row is re-applied on every bare-URL load. Rewrite
-- those rows to 'none' so the flat default reaches them too (Sebastian's call, 27 Sep:
-- "Backfill to flat").
--
-- Scope: only the Objects page rows, i.e. one per object type plus the "__all__" row. The
-- rows other screens keep in this table are left alone: 'agents' (Agents index, which has
-- its own State grouping), 'files', 'loop' and '__chrome__'.
--
-- user_display_settings is not a hot table (MIGRATIONS.md): it is only touched by a person
-- changing their own view, so a single UPDATE is fine. Idempotent: the WHERE clause needs
-- groupBy = 'status', which the first run removes. A person who picks Group by State again
-- afterwards writes 'status' back and keeps it; this runs once.

UPDATE "user_display_settings"
SET "settings" = jsonb_set("settings", '{groupBy}', '"none"'::jsonb)
WHERE "settings"->>'groupBy' = 'status'
	AND "object_type" NOT IN ('agents', 'files', 'loop', '__chrome__');
