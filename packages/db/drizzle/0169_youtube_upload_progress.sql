-- YouTube upload progress (bet "YouTube integration", part 5, task "Agent can prepare a video
-- upload that is always private"). Three nullable or defaulted columns on youtube_pending_actions,
-- so an upload that was cut off resumes where Google left off instead of starting again.
--
-- An approved request cannot change (its hash is checked at the tap and again at the run), so the
-- progress cannot live in the payload. upload_session_uri is Google's resumable session address
-- (anyone holding it can add bytes to that one upload, so it is cleared when the action ends).
-- upload_bytes_sent is the last byte count Google confirmed. upload_attempts counts runs of the
-- upload, so a file that keeps failing stops after a few tries.
--
-- Additive columns on a small, new table (see 0167), not on the hot-tables list (see MIGRATIONS.md),
-- so plain DDL is fine and there is nothing to backfill.
-- Down: drizzle/down/0169_youtube_upload_progress_down.sql.

ALTER TABLE "youtube_pending_actions" ADD COLUMN IF NOT EXISTS "upload_session_uri" text;
--> statement-breakpoint
ALTER TABLE "youtube_pending_actions" ADD COLUMN IF NOT EXISTS "upload_bytes_sent" bigint;
--> statement-breakpoint
ALTER TABLE "youtube_pending_actions" ADD COLUMN IF NOT EXISTS "upload_attempts" integer NOT NULL DEFAULT 0;
