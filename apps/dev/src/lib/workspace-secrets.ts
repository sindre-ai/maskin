import { decrypt, encrypt } from './crypto'
import { logger } from './logger'

/**
 * Seals and opens the LLM secrets held in `workspaces.settings`: every
 * `llm_keys.*` value and `custom_llm.api_key`. Nothing else in settings is
 * credential-shaped (`claude_oauth` is sealed by its own routes).
 *
 * A sealed value is `enc:v1:` + the `hex:hex:hex` string from crypto.ts, under
 * the same INTEGRATION_ENCRYPTION_KEY as integration credentials. The prefix is
 * what tells ciphertext from a value saved before sealing existed: a value
 * without it is read as plaintext, so old keys keep working until the one-off
 * re-encrypt script has run.
 */
export const SEALED_PREFIX = 'enc:v1:'

type JsonRecord = Record<string, unknown>

/** A stored secret that cannot be turned back into its plain value. */
export class SecretUnreadableError extends Error {
	/** Settings path of the value, e.g. `llm_keys.anthropic`. Never the value itself. */
	readonly field: string

	constructor(field: string, cause: unknown) {
		super(`The stored value of ${field} cannot be decrypted`, { cause })
		this.name = 'SecretUnreadableError'
		this.field = field
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSealed(stored: string): boolean {
	return stored.startsWith(SEALED_PREFIX)
}

export function sealSecret(plain: string): string {
	return `${SEALED_PREFIX}${encrypt(plain)}`
}

/**
 * Plain value of a stored secret. A value without the prefix is returned as is
 * and never touches the encryption key. Throws {@link SecretUnreadableError}
 * when a sealed value cannot be opened (key missing, rotated, or data damaged).
 */
export function openSecret(stored: string, field = 'secret'): string {
	if (!isSealed(stored)) return stored
	try {
		return decrypt(stored.slice(SEALED_PREFIX.length))
	} catch (err) {
		throw new SecretUnreadableError(field, err)
	}
}

/** Applies `fn` to each secret string in settings, on a copy. Null and empty values pass through. */
function mapSecrets(settings: unknown, fn: (value: string, field: string) => string | undefined) {
	if (!isRecord(settings)) return settings
	const next: JsonRecord = { ...settings }

	if (isRecord(settings.llm_keys)) {
		const keys: JsonRecord = { ...settings.llm_keys }
		for (const [provider, value] of Object.entries(keys)) {
			if (typeof value !== 'string' || value === '') continue
			const mapped = fn(value, `llm_keys.${provider}`)
			if (mapped === undefined) delete keys[provider]
			else keys[provider] = mapped
		}
		next.llm_keys = keys
	}

	if (isRecord(settings.custom_llm)) {
		const custom: JsonRecord = { ...settings.custom_llm }
		if (typeof custom.api_key === 'string' && custom.api_key !== '') {
			const mapped = fn(custom.api_key, 'custom_llm.api_key')
			if (mapped === undefined) delete custom.api_key
			else custom.api_key = mapped
		}
		next.custom_llm = custom
	}

	return next
}

/** Settings with every LLM secret sealed. Call on values that came from a request. */
export function sealWorkspaceLlmSecrets<T>(settings: T): T {
	return mapSecrets(settings, (value) => sealSecret(value)) as T
}

/**
 * Settings with every LLM secret opened.
 *
 * Throws {@link SecretUnreadableError} on the first value that cannot be
 * opened. With `omitUnreadable` that value is left out instead and a warning
 * naming only the field is logged: for responses and comparisons, where one bad
 * value must not break the whole workspace.
 */
export function openWorkspaceLlmSecrets<T>(settings: T, options?: { omitUnreadable?: boolean }): T {
	return mapSecrets(settings, (value, field) => {
		try {
			return openSecret(value, field)
		} catch (err) {
			if (!options?.omitUnreadable) throw err
			logger.warn('Stored LLM secret cannot be decrypted; leaving it out', { field })
			return undefined
		}
	}) as T
}

/** How many LLM secrets in settings are sealed and how many are still plaintext. Never reads a value out. */
export function countWorkspaceLlmSecrets(settings: unknown): { sealed: number; plain: number } {
	const counts = { sealed: 0, plain: 0 }
	mapSecrets(settings, (value) => {
		if (isSealed(value)) counts.sealed++
		else counts.plain++
		return value
	})
	return counts
}

/**
 * Settings with the LLM secrets moved one way: `seal` seals the plaintext ones,
 * `open` opens the sealed ones. Values already in the target form are left
 * alone, so running it twice changes nothing. Used by the one-off
 * encrypt-workspace-llm-secrets script; `open` is its way back if the sealing
 * code is rolled back. Throws {@link SecretUnreadableError} in `open` mode.
 */
export function rewriteWorkspaceLlmSecrets<T>(
	settings: T,
	mode: 'seal' | 'open',
): { settings: T; rewritten: number } {
	let rewritten = 0
	const next = mapSecrets(settings, (value, field) => {
		if (mode === 'seal') {
			if (isSealed(value)) return value
			rewritten++
			return sealSecret(value)
		}
		if (!isSealed(value)) return value
		rewritten++
		return openSecret(value, field)
	}) as T
	return { settings: next, rewritten }
}
