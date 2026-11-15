-- Rollback for 0153_chat_sections.sql. Drops every person's sections and which chats sit in them,
-- which cannot be rebuilt. The chats themselves stay. Roll back the code that reads them first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "chat_section_items";
--> statement-breakpoint
DROP TABLE IF EXISTS "chat_sections";
