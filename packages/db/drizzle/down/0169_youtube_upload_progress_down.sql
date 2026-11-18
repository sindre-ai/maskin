-- Rollback for 0169_youtube_upload_progress.sql. Loses the progress of uploads still running, which
-- then cannot resume. Roll back the code that reads the columns first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "youtube_pending_actions" DROP COLUMN IF EXISTS "upload_attempts";
ALTER TABLE "youtube_pending_actions" DROP COLUMN IF EXISTS "upload_bytes_sent";
ALTER TABLE "youtube_pending_actions" DROP COLUMN IF EXISTS "upload_session_uri";
