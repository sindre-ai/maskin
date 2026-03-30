-- Fix: Remove `data` from PG NOTIFY payload to prevent "payload string too long" errors.
-- PostgreSQL NOTIFY has an 8KB limit; large entity data (e.g. notifications with big content)
-- can exceed this. SSE consumers only need metadata fields for cache invalidation.
-- The full data remains in the events table for history/audit queries.

CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify('events', json_build_object(
		'event_id', NEW.id::text,
		'workspace_id', NEW.workspace_id::text,
		'actor_id', NEW.actor_id::text,
		'action', NEW.action,
		'entity_type', NEW.entity_type,
		'entity_id', NEW.entity_id::text
	)::text);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
