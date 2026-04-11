-- PG NOTIFY trigger for session_logs: broadcasts new log entries for live SSE streaming
CREATE OR REPLACE FUNCTION notify_session_log() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify('session_logs', json_build_object(
		'id', NEW.id,
		'session_id', NEW.session_id::text,
		'stream', NEW.stream,
		'content', NEW.content
	)::text);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER session_logs_notify
	AFTER INSERT ON "session_logs"
	FOR EACH ROW
	EXECUTE FUNCTION notify_session_log();
