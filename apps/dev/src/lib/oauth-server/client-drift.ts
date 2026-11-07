import type { PinnedMcpOAuthClient } from '@maskin/shared'

const SCALAR_FIELDS = [
	'client_id',
	'client_name',
	'client_uri',
	'token_endpoint_auth_method',
] as const
const LIST_FIELDS = ['redirect_uris', 'grant_types', 'response_types'] as const

function sortedList(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null
	return [...value].sort()
}

/**
 * Compare the pinned Claude client record with the document Claude publishes now. Returns one
 * line per field that differs, empty when they match. Lists compare as sets (order is not
 * meaningful). Pure: it fetches nothing and changes nothing, so the runtime never depends on it.
 */
export function diffClientRecord(pinned: PinnedMcpOAuthClient, live: unknown): string[] {
	if (!live || typeof live !== 'object' || Array.isArray(live)) {
		return ['the live document is not a JSON object']
	}
	const doc = live as Record<string, unknown>
	const differences: string[] = []

	for (const field of SCALAR_FIELDS) {
		if (doc[field] !== pinned[field]) {
			differences.push(
				`${field}: pinned ${JSON.stringify(pinned[field])}, live ${JSON.stringify(doc[field])}`,
			)
		}
	}
	for (const field of LIST_FIELDS) {
		const pinnedList = sortedList(pinned[field]) as string[]
		const liveList = sortedList(doc[field])
		if (!liveList || JSON.stringify(liveList) !== JSON.stringify(pinnedList)) {
			differences.push(
				`${field}: pinned ${JSON.stringify(pinnedList)}, live ${JSON.stringify(doc[field])}`,
			)
		}
	}
	return differences
}
