-- Carry the knowledge customer_facing field to workspaces that already have it stored.
--
-- KNOWLEDGE_FIELDS in extensions/knowledge/shared.ts only seeds workspaces that enable knowledge from
-- now on: a workspace's stored settings.field_definitions.knowledge always wins, and it never gains
-- new default fields on its own. Without this, no existing workspace could flip a knowledge object
-- to customer_facing (the Telnyx voice agent's knowledge export reads only those).
--
-- Append only: existing entries keep their order and nothing is removed. A workspace whose stored
-- list already has customer_facing is skipped, so running this twice leaves the list identical to
-- running it once. Workspaces with no stored knowledge field list are untouched (a fresh
-- enablement seeds the defaults).
UPDATE workspaces
SET settings = jsonb_set(
	settings,
	'{field_definitions,knowledge}',
	(settings->'field_definitions'->'knowledge')
		|| '[{"name": "customer_facing", "type": "boolean"}]'::jsonb,
	false
)
WHERE jsonb_typeof(settings->'field_definitions'->'knowledge') = 'array'
	AND NOT EXISTS (
		SELECT 1
		FROM jsonb_array_elements(settings->'field_definitions'->'knowledge') AS elem
		WHERE elem->>'name' = 'customer_facing'
	);
