-- Allow in this chat for 8 hours on a connected integration (Calendar, Meet). A chat grant for a
-- built-in integration stops counting at expires_at; the resolver checks it on every call.
-- Existing rows are Keychain chat grants: expires_at stays NULL for them and they behave as before.
--
-- Additive and nullable, so a revert of the code leaves the column unused. agent_chat_grants is a
-- few rows per workspace and not on the hot-tables list (see MIGRATIONS.md), so a plain ALTER is fine.
-- Down: drizzle/down/0149_agent_chat_grants_expires_at_down.sql.

ALTER TABLE "agent_chat_grants" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
