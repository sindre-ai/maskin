-- Add nullable `avatar_url` to `actors`. Existing rows stay null and render
-- initials via the T1 ActorAvatar fallback; the T5 upload endpoint populates
-- this column with the URL of a downsized square image in S3.

ALTER TABLE "actors" ADD COLUMN "avatar_url" text;
