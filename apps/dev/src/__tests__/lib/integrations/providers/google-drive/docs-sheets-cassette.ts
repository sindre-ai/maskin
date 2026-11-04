import { vi } from 'vitest'

interface Interaction {
	/** Decoded URL path, and the query params that must match (others are ignored). */
	match: { path: string; params?: Record<string, string> }
	status: number
	body: unknown
}

/**
 * Replay a cassette of Docs API and Sheets API interactions through
 * globalThis.fetch. A request matches on its decoded path plus the listed query
 * params; an unmatched request fails the test loudly rather than returning
 * something plausible. Returns the spy so a test can assert on the requests made.
 */
export function replayDocsSheetsCassette(cassette: { interactions: Interaction[] }) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const u = new URL(String(input))
		const path = decodeURIComponent(u.pathname)
		const hit = cassette.interactions.find(
			(i) =>
				i.match.path === path &&
				Object.entries(i.match.params ?? {}).every(([k, v]) => u.searchParams.get(k) === v),
		)
		if (!hit) throw new Error(`cassette miss: ${path}${u.search}`)
		return new Response(JSON.stringify(hit.body), { status: hit.status })
	})
}
