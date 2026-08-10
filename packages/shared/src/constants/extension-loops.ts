// Canonical identifiers for the extension marketplace loops.
//
// Extensions used to be toggled by hand in Settings → General. That surface is
// gone: a workspace now gets an extension by installing the matching loop from
// the marketplace, which is the single install path for agents, skills,
// triggers and extensions alike.
//
// Unlike actor/trigger/skill items, an extension has no row in a publishing
// workspace to take its `source_item_id` from — an extension is code
// (`extensions/<id>/`), registered globally at boot. So each one gets a
// hand-authored, stable UUID here instead. These ids are the dedup and
// version-push identity for the item, so they must never change once shipped.
//
// Naming: "extension" is the word everywhere, including in new code. The
// `@maskin/module-sdk` registry API (`registerModule`, `getModuleDefaultSettings`)
// and the persisted `workspaces.settings.enabled_modules` key still say
// "module" — those are pre-existing names, and the settings key is stored data
// that can't be renamed without migrating every workspace.

export const EXTENSION_ITEM_ID_WORK = 'e0000000-0000-4000-8000-000000000001'
export const EXTENSION_ITEM_ID_KNOWLEDGE = 'e0000000-0000-4000-8000-000000000002'
export const EXTENSION_ITEM_ID_CRM = 'e0000000-0000-4000-8000-000000000003'

export const EXTENSION_LOOP_VERSION = '1.0.0'
export const EXTENSION_LOOP_USE_CASE = 'Extensions'

export const WORK_EXTENSION_LOOP_SLUG = 'work-extension-loop'
export const WORK_EXTENSION_LOOP_NAME = 'Work Extension'
export const WORK_EXTENSION_LOOP_DESCRIPTION =
	'Adds the Work extension: insights, bets and tasks — the core object types for running strategic work in a workspace.'

export const KNOWLEDGE_EXTENSION_LOOP_SLUG = 'knowledge-extension-loop'
export const KNOWLEDGE_EXTENSION_LOOP_NAME = 'Knowledge Extension'
export const KNOWLEDGE_EXTENSION_LOOP_DESCRIPTION =
	'Adds the Knowledge extension: articles, so the workspace can capture durable know-how alongside its running work.'

export const CRM_EXTENSION_LOOP_SLUG = 'crm-extension-loop'
export const CRM_EXTENSION_LOOP_NAME = 'CRM Extension'
export const CRM_EXTENSION_LOOP_DESCRIPTION =
	'Adds the CRM extension: contacts and companies, so sales and relationship work lives in the same graph as everything else.'
