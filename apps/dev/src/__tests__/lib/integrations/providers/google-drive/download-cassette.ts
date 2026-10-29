import { vi } from 'vitest'

interface Interaction {
	match: { path: string; params: Record<string, string> }
	status: number
	json?: unknown
	bodyBase64?: string
}

/**
 * Replay a cassette of Drive file download interactions through globalThis.fetch.
 * A request matches when its path is equal and every listed query param is equal.
 * An unmatched request fails the test loudly. Returns the spy so a test can
 * assert on the requests that were made.
 */
export function replayDownloadCassette(cassette: { interactions: Interaction[] }) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const u = new URL(String(input))
		const hit = cassette.interactions.find(
			(i) =>
				i.match.path === u.pathname &&
				Object.entries(i.match.params).every(([k, v]) => u.searchParams.get(k) === v),
		)
		if (!hit) throw new Error(`cassette miss: ${u.pathname}${u.search}`)
		if (hit.bodyBase64 !== undefined) {
			const bytes = Buffer.from(hit.bodyBase64, 'base64')
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes)
						controller.close()
					},
				}),
				{ status: hit.status },
			)
		}
		return new Response(JSON.stringify(hit.json ?? {}), { status: hit.status })
	})
}
