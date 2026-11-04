-- Direct-to-storage uploads of large files (multipart, presigned URLs).
--
-- files.size_bytes becomes bigint: an integer tops out at 2 GiB, and large
-- uploads are meant to grow past that. The files table is small and not on a
-- hot path (see MIGRATIONS.md), so the rewrite this ALTER does is cheap.
--
-- file_uploads remembers what an in-flight upload declared, so completing it
-- can verify the stored object before the files row exists.
ALTER TABLE "files" ALTER COLUMN "size_bytes" TYPE bigint;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"s3_upload_id" text NOT NULL,
	"part_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "file_uploads_file_id_unique" UNIQUE ("file_id"),
	CONSTRAINT "file_uploads_status_check" CHECK ("status" IN ('pending', 'completing', 'completed', 'aborted'))
);
--> statement-breakpoint
ALTER TABLE "file_uploads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_uploads_ws_status_idx" ON "file_uploads" ("workspace_id", "status");
--> statement-breakpoint
-- The reaper looks for abandoned uploads by age; only open ones matter.
CREATE INDEX IF NOT EXISTS "file_uploads_open_idx" ON "file_uploads" ("expires_at")
	WHERE "status" IN ('pending', 'completing');
