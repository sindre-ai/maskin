import { MASKED_VALUE } from './actor-tools-redaction'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Both spellings occur: the schema writes api_key, older rows and the
// marketplace snapshot code use apiKey.
function isSecretKey(key: string): boolean {
	const lower = key.toLowerCase()
	return lower === 'api_key' || lower === 'apikey'
}

/**
 * Copy of an actor's llm_config with the value of every api_key / apiKey, at any
 * depth, replaced by MASKED_VALUE. Keys stay, so the config still shows that a
 * key is set. Applied for every caller: nothing reads the plaintext back.
 */
export function maskLlmConfigSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(maskLlmConfigSecrets)
	if (!isRecord(value)) return value
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			isSecretKey(key) && entry !== null && entry !== undefined
				? MASKED_VALUE
				: maskLlmConfigSecrets(entry),
		]),
	)
}

/**
 * Write-back for an llm_config that was read masked: every MASKED_VALUE api key
 * in the incoming config is replaced by the stored value at the same path, so a
 * read-modify-write never overwrites the key with the mask.
 *
 * Masks with nothing to restore are returned in `unresolved` as a dotted path
 * (never a value) so the caller can reject the write.
 */
export function restoreMaskedLlmConfig(
	incoming: unknown,
	stored: unknown,
	path = 'llm_config',
): { llmConfig: unknown; unresolved: string[] } {
	if (Array.isArray(incoming)) {
		const storedItems = Array.isArray(stored) ? stored : []
		const items = incoming.map((item, index) =>
			restoreMaskedLlmConfig(item, storedItems[index], `${path}.${index}`),
		)
		return {
			llmConfig: items.map((item) => item.llmConfig),
			unresolved: items.flatMap((item) => item.unresolved),
		}
	}
	if (!isRecord(incoming)) return { llmConfig: incoming, unresolved: [] }

	const storedRecord = isRecord(stored) ? stored : {}
	const unresolved: string[] = []
	const restored: JsonRecord = {}
	for (const [key, entry] of Object.entries(incoming)) {
		const keyPath = `${path}.${key}`
		if (isSecretKey(key) && entry === MASKED_VALUE) {
			const storedValue = storedRecord[key]
			if (typeof storedValue === 'string') restored[key] = storedValue
			else unresolved.push(keyPath)
			continue
		}
		const child = restoreMaskedLlmConfig(entry, storedRecord[key], keyPath)
		restored[key] = child.llmConfig
		unresolved.push(...child.unresolved)
	}
	return { llmConfig: restored, unresolved }
}
