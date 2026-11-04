import { vi } from 'vitest'

interface Interaction {
	match: { q: string; pageToken: string | null }
	status: number
	body: unknown
}

/**
 * Replay a cassette of Drive files.list interactions through globalThis.fetch.
 * Each request is matched on (q, pageToken); an unmatched request fails the
 * test loudly rather than returning something plausible. Returns the spy so a
 * test can assert on the requests that were made.
 */
export function replayCassette(cassette: { interactions: Interaction[] }) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const u = new URL(String(input))
		const q = u.searchParams.get('q') ?? ''
		const pageToken = u.searchParams.get('pageToken')
		const hit = cassette.interactions.find(
			(i) => i.match.q === q && i.match.pageToken === pageToken,
		)
		if (!hit) throw new Error(`cassette miss: q=${q} pageToken=${pageToken}`)
		return new Response(JSON.stringify(hit.body), { status: hit.status })
	})
}
