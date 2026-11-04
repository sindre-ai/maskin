-- Text anchor for comments on selected text: { quote, prefix, suffix }.
-- Nullable and additive; existing comments are untouched and keep NULL.
-- The legacy "selector" column is not reused.
ALTER TABLE "file_comments" ADD COLUMN IF NOT EXISTS "text_anchor" jsonb;
