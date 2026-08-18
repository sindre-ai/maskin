-- Promotes config.conversation.conversation_id to a real, indexable column —
-- same treatment `interactive` already got. Needed so the conversation-
-- responder's "does a running interactive session already exist for this
-- (conversation, agent)?" lookup doesn't do an unindexed JSONB path scan.
-- Nullable/no default: cheap ALTER, no table rewrite, no lock beyond a brief
-- catalog update even on a large table.
ALTER TABLE "sessions" ADD COLUMN "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL;
