-- One index scan per branch segment when resolving a branched thread.
-- CONCURRENTLY and alone in its file per packages/db/MIGRATIONS.md Rule 1:
-- `messages` is written on the synchronous path of every chat post, so a plain
-- CREATE INDEX would hold a SHARE lock and stall live sends for the build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_conversation_branch_id_idx"
	ON "messages" USING btree ("conversation_id", "branch_id", "id");
