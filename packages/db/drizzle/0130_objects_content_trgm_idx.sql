-- Migration: make the object body match in GET /api/search use an index (2 of 2, title is 0129).
--
-- The body half of the objects word filter described in 0129. Same shape as that index and as
-- messages_conv_content_trgm_idx (0124), with workspace_id as the first key.
--
-- Size: on a test set with production's shape (22,000 objects, about 59 MB of text) the build took
-- about 9 s and the index is about 8.5 MB; its twin on the title is about 1 MB. Each object write
-- pays a small extra cost to keep it current. Words of fewer than 3 letters still scan.
--
-- Alone in its file, built CONCURRENTLY with IF NOT EXISTS, for the reasons in 0129.
--
-- Needs 0122 and 0123. Reversible: drizzle/down/0130_objects_content_trgm_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "objects_ws_content_trgm_idx"
  ON "objects" USING gin ("workspace_id", "content" gin_trgm_ops);
