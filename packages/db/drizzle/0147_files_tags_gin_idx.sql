-- Serves the tag filters on the files list: "has all of these tags" (tags @> ...) and "has any of
-- these tags" (tags && ...). A btree cannot answer either; GIN can.
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other statements
-- (see packages/db/MIGRATIONS.md Rule 1). If an interrupted build leaves an INVALID index, drop it
-- first. Down: drizzle/down/0147_files_tags_gin_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "files_tags_gin_idx"
  ON "files" USING gin ("tags");
