-- Rollback for 0097_conversation_subjects.sql. The subject links are lost; the chats stay.
DROP INDEX IF EXISTS "conversations_subject_uniq";
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_subject_check";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "subject_id";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "subject_type";
