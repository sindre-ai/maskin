import { openWorkspaceLlmSecrets } from './workspace-secrets'

/**
 * Settings keys that hold credentials or billing internals (Stripe ids, plan,
 * spend cap). Only a human workspace admin or owner gets them back in a
 * workspace response; everyone else (plain members and every agent key) gets
 * the settings object without them. No web or Apple screen reads billing or
 * claude_oauth from workspace settings: both have their own routes.
 *
 * Omitted, not masked: the web screens PATCH the settings object they read back
 * in, so a placeholder string would either overwrite the real value for an
 * admin or read as a changed value for a member.
 */
const ADMIN_ONLY_SETTINGS_KEYS = ['llm_keys', 'custom_llm', 'claude_oauth', 'billing'] as const

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasValue(value: unknown): boolean {
	return typeof value === 'string' && value.length > 0
}

/** Copy of a workspace settings object without the admin-only keys. */
export function redactWorkspaceSettings(settings: unknown): JsonRecord {
	const copy: JsonRecord = isRecord(settings) ? { ...settings } : {}
	for (const key of ADMIN_ONLY_SETTINGS_KEYS) delete copy[key]
	return copy
}

/**
 * Whether a key is stored, for every caller. Top level on the response and not
 * inside settings, so it is never spread back into a PATCH body.
 */
export function llmConfigured(settings: unknown) {
	const stored = isRecord(settings) ? settings : {}
	const keys = isRecord(stored.llm_keys) ? stored.llm_keys : {}
	const custom = isRecord(stored.custom_llm) ? stored.custom_llm : {}
	return {
		anthropic: hasValue(keys.anthropic),
		openai: hasValue(keys.openai),
		custom_llm: hasValue(custom.api_key),
	}
}

/**
 * The workspace row a caller may see: settings for a human admin or owner (the
 * LLM keys opened, since they are sealed at rest; one that cannot be opened is
 * left out), without the admin-only keys for anyone else, plus llm_configured.
 */
export function workspaceForCaller<T extends { settings: unknown }>(
	row: T,
	callerIsHumanAdminOrOwner: boolean,
) {
	return {
		...row,
		settings: callerIsHumanAdminOrOwner
			? openWorkspaceLlmSecrets(row.settings, { omitUnreadable: true })
			: redactWorkspaceSettings(row.settings),
		llm_configured: llmConfigured(row.settings),
	}
}
