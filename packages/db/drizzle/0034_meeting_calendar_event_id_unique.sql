-- Partial unique index preventing duplicate `meeting` objects for the same
-- Google Calendar event in a workspace. Two pushes carrying different webhook
-- delivery ids (e.g. channel rotation or intermediate-state pushes) can race
-- past the SELECT-then-INSERT guard in `upsertMeetingFromEvent`. The DB-level
-- constraint makes the loser of the race surface a `23505` unique_violation,
-- which the fan-out catches and converts into an UPDATE — see
-- apps/dev/src/lib/integrations/providers/google-calendar/watch.ts.
--
-- NULL `calendarEventId` is excluded so non-calendar meetings (e.g. ad-hoc
-- Skjald rooms with no source event) remain freely insertable. The predicate
-- also guards `type='meeting'` so insights/bets/tasks are unaffected.
--
-- If this migration fails to build, the most likely cause is a pre-existing
-- duplicate from before the fix shipped; resolve by dropping the offending
-- duplicate row before re-running.
CREATE UNIQUE INDEX IF NOT EXISTS objects_meeting_calendar_event_id_uniq
  ON objects (workspace_id, (metadata->>'calendarEventId'))
  WHERE type = 'meeting' AND metadata->>'calendarEventId' IS NOT NULL;
