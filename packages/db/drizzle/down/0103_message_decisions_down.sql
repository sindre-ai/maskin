-- Rollback for 0103_message_decisions.sql. Decision state is lost; the cards stay on their messages.
DROP TABLE IF EXISTS "message_decisions";
