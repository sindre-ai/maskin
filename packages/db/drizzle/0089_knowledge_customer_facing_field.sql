-- Carry the knowledge customer_facing field to workspaces that already store knowledge fields.
--
-- KNOWLEDGE_FIELDS in extensions/knowledge/shared.ts only seeds workspaces that enable the
-- knowledge module from now on: mergeModuleDefaultSettings lets a workspace's stored
-- settings.field_definitions.knowledge always win. Without this, an existing workspace never
-- lists customer_facing in its schema, and the Telnyx knowledge exporter's switch is invisible.
--
-- Append only: existing entries keep their order and nothing is removed. A workspace whose
-- stored list already holds customer_facing is skipped, so running this twice leaves every
-- list identical to running it once. Workspaces with no stored knowledge field list are
-- untouched (a fresh enablement seeds the defaults). Absence reads as false.
UPDATE workspaces
SET settings = jsonb_set(
	settings,
	'{field_definitions,knowledge}',
	(settings->'field_definitions'->'knowledge') || '[{"name": "customer_facing", "type": "boolean"}]'::jsonb
)
WHERE jsonb_typeof(settings->'field_definitions'->'knowledge') = 'array'
	AND NOT EXISTS (
		SELECT 1
		FROM jsonb_array_elements(settings->'field_definitions'->'knowledge') AS f
		WHERE f->>'name' = 'customer_facing'
	);
