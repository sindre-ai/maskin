-- Rollback for 0148. Puts the four workspace defaults back to ask_first (the 0131 values), again
-- only for untouched rows (no agent, no person has edited them). A default a person has since
-- set to always_allow through the settings screen has updated_by set and is left alone.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

UPDATE "send_permissions"
SET "mode" = 'ask_first'
WHERE "agent_id" IS NULL
	AND "updated_by" IS NULL
	AND "mode" = 'always_allow'
	AND "kind" IN ('email', 'linkedin_message', 'linkedin_connection_request', 'linkedin_inmail');
