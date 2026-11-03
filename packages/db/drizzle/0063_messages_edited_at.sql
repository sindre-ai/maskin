-- Message editing: stamp when the author last edited a message. Nullable, no
-- default — a metadata-only ALTER on the hot messages table (no rewrite).
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;
