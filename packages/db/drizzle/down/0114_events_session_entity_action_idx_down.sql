-- Rollback for 0114_events_session_entity_action_idx.sql.
DROP INDEX CONCURRENTLY IF EXISTS "events_session_entity_action_idx";
