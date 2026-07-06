-- Rollback: remove conversations, conversation_participants, and messages tables

DROP TABLE IF EXISTS "messages";
DROP TABLE IF EXISTS "conversation_participants";
DROP TABLE IF EXISTS "conversations";
