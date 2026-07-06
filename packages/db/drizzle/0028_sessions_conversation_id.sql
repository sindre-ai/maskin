ALTER TABLE "sessions" ADD COLUMN "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL;
CREATE INDEX "sessions_conversation_id_idx" ON "sessions" ("conversation_id");
