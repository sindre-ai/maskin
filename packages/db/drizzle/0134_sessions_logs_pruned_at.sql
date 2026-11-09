-- Log retention sweep: remember which sessions it has already cleaned (1 of 2, the index is 0135).
--
-- The hourly sweep in session-manager (pruneSessionLogs) picks finished non-interactive sessions
-- older than 30 days that still hold old log rows. On production (5 Nov) that query took 11 to 20 s:
-- it walked about 124,646 old sessions with a log look-up each, and only 68 still had old logs.
-- With this column the sweep marks a session once its old logs are gone and never reads it again.
--
-- Nullable column with no default, so the ALTER is a metadata-only change and existing rows stay
-- NULL ("not cleaned yet"). The sweep works through that backlog in short slices and marks each
-- session as it goes, so no backfill is needed here. sessions is not on the hot-tables list (see
-- packages/db/MIGRATIONS.md); a plain ADD COLUMN takes its lock for an instant.
-- Down: drizzle/down/0134_sessions_logs_pruned_at_down.sql.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "logs_pruned_at" timestamp with time zone;
