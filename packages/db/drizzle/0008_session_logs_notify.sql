-- PG NOTIFY trigger for session_logs: broadcasts new log entries for live SSE streaming.
-- Truncates content to 7000 chars to stay within PostgreSQL's 8KB NOTIFY payload limit
-- (see 0006_notify_drop_data.sql for the same fix on the events table).
-- The full content is always available in the session_logs table.
CREATE OR REPLACE FUNCTION notify_session_log() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify('session_logs', json_build_object(
		'id', NEW.id,
		'session_id', NEW.session_id::text,
		'stream', NEW.stream,
		'content', left(NEW.content, 7000)
	)::text);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER session_logs_notify
	AFTER INSERT ON "session_logs"
	FOR EACH ROW
	EXECUTE FUNCTION notify_session_log();
