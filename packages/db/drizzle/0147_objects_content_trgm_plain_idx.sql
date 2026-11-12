-- Migration: trigram index on objects.content WITHOUT the workspace key (2 of 2, title is 0146).
--
-- The body half of the object search word filter. Why it has no workspace_id key is explained in
-- 0146: with workspace_id in the index the planner ignores the trigram key for this query.
--
-- Size: a GIN trigram index is of the order of the indexed text. On the 22,000 object test set
-- (64 MB of body text built from random hex-like words, close to the worst case for trigrams) it
-- is 56 MB and builds in 24 s; real prose compresses much better (the workspace-keyed twin 0130
-- measured 8.5 MB for 59 MB of production-shaped text). Write cost: bulk-inserting 3,000 objects
-- with 2.4 KB bodies took 8.6 s without the two indexes of 0146/0147 and 13.4 s with them, about
-- 1.6 ms more per object (GIN batches inserts in a pending list, so single writes pay less).
-- Check the real size with pg_relation_size after the build.
--
-- Alone in its file, built CONCURRENTLY with IF NOT EXISTS, for the reasons in 0146. An
-- interrupted build leaves an INVALID index: drop it before retrying.
--
-- Needs 0122 (pg_trgm). Reversible: drizzle/down/0147_objects_content_trgm_plain_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "objects_content_trgm_idx"
  ON "objects" USING gin ("content" gin_trgm_ops);
