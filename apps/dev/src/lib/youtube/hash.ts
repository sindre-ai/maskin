import { createHash } from 'node:crypto'

/** Copy of a JSON value with object keys sorted at every level and undefined dropped. */
export function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, sortKeys(v)]),
		)
	}
	return value
}

/** JSON with keys sorted at every level, so the same request always hashes the same. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value)) ?? 'null'
}

export function hashYoutubePayload(payload: unknown): string {
	return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}
