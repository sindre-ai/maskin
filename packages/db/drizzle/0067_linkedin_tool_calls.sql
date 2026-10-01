-- LinkedIn (Unipile-backed) content/community tools content-hash idempotency
-- ledger. Task 7b of the "First-party LinkedIn MCP" bet — Unipile v2's
-- create-post / comment / reply-to-comment endpoints do NOT accept an
-- Idempotency-Key header (unlike the messaging surface, which uses the
-- shared `idempotency_records` table). This table takes the place of that
-- header for the four destructive content/community tools:
--   - linkedin_publish_post
--   - linkedin_publish_business_page_post
--   - linkedin_comment_on_post
--   - linkedin_reply_to_comment
--
-- Two identical tool calls (same actor, same tool, same canonical-JSON
-- request body → same sha256 hash) collide on the primary key. The first
-- INSERT wins, claims the row, and hits Unipile; the second loses the race and
-- either replays the winner's stored `response` verbatim or, if the winner is
-- still in flight, refuses rather than publishing a second time. See migration
-- 0068, which adds the `status` column that makes the claim possible -- this
-- table as created here deduplicated bookkeeping but did not serialise
-- callers. Purged nightly after 24h -- see
-- `apps/dev/src/jobs/purge-idempotency.ts`.
--
-- Read tools (`linkedin_read_post_comments`, `linkedin_get_post_engagement`)
-- have no side effect and are deliberately NOT dedup'd here.

CREATE TABLE IF NOT EXISTS "linkedin_tool_calls" (
	"actor_id" text NOT NULL,
	"tool" text NOT NULL,
	"content_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	PRIMARY KEY ("actor_id", "tool", "content_hash")
);

CREATE INDEX IF NOT EXISTS "linkedin_tool_calls_created_at_idx"
	ON "linkedin_tool_calls" ("created_at");
