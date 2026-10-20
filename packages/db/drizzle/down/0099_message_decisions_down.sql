-- Rollback for 0099_message_decisions.sql. Decision state is lost; the cards stay on their messages.
DROP TABLE IF EXISTS "message_decisions";
