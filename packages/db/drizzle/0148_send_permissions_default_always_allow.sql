-- Write access sends: flip the four workspace defaults that 0131 wrote as ask_first (email,
-- LinkedIn message, connection request, InMail) to always_allow, so an agent with Read & write
-- on the integration sends without waiting for a card (Sebastian, 11 Nov 2026). The send gate
-- now reads this table, so leaving the 4 Nov defaults in place would keep those kinds asking.
--
-- Only rows nobody has touched: agent_id IS NULL (the workspace default, not a per-agent
-- choice) and updated_by IS NULL (no person has edited it since 0131 wrote it). Per-agent
-- ask_first rows and any default a person changed are left as they are.
--
-- send_permissions is a few rows per workspace and not on the hot-tables list (see
-- MIGRATIONS.md), so a plain UPDATE is fine.
-- Down: drizzle/down/0148_send_permissions_default_always_allow_down.sql.

UPDATE "send_permissions"
SET "mode" = 'always_allow'
WHERE "agent_id" IS NULL
	AND "updated_by" IS NULL
	AND "mode" = 'ask_first'
	AND "kind" IN ('email', 'linkedin_message', 'linkedin_connection_request', 'linkedin_inmail');
