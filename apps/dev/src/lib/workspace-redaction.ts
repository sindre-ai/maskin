import { hintOf } from './workspace-secrets'

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
 * Settings for a human admin or owner: everything except the LLM secrets. The
 * keys are write-only, so llm_keys is left out and custom_llm loses its
 * api_key. An absent key in a PATCH body means no change, so a screen that
 * spreads this object back never touches a stored key.
 */
function withoutLlmSecrets(settings: unknown): JsonRecord {
	const {
		llm_keys: _keys,
		custom_llm,
		...rest
	} = isRecord(settings) ? settings : ({} as JsonRecord)
	if (!isRecord(custom_llm)) return custom_llm === undefined ? rest : { ...rest, custom_llm }
	const { api_key: _apiKey, ...endpoint } = custom_llm
	return { ...rest, custom_llm: endpoint }
}

/**
 * Last four characters of each stored key, all the settings screen shows of a
 * saved key. Null where no key is stored or the key is too short to hint at.
 * Top level on the response, like llm_configured, so it is never spread back
 * into a PATCH body.
 */
export function llmKeyHints(settings: unknown) {
	const stored = isRecord(settings) ? settings : {}
	const keys = isRecord(stored.llm_keys) ? stored.llm_keys : {}
	const custom = isRecord(stored.custom_llm) ? stored.custom_llm : {}
	return {
		anthropic: hintOf(keys.anthropic),
		openai: hintOf(keys.openai),
		custom_llm: hintOf(custom.api_key),
	}
}

/**
 * The workspace row a caller may see. No caller gets an LLM key back: a human
 * admin or owner gets settings without the keys plus llm_key_hints, everyone
 * else gets settings without the admin-only keys. llm_configured is for all.
 */
export function workspaceForCaller<T extends { settings: unknown }>(
	row: T,
	callerIsHumanAdminOrOwner: boolean,
) {
	const shaped = {
		...row,
		settings: callerIsHumanAdminOrOwner
			? withoutLlmSecrets(row.settings)
			: redactWorkspaceSettings(row.settings),
		llm_configured: llmConfigured(row.settings),
	}
	return callerIsHumanAdminOrOwner
		? { ...shaped, llm_key_hints: llmKeyHints(row.settings) }
		: shaped
}
