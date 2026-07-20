import { describe, expect, it, vi } from 'vitest'
import { fetchHeartbeat } from '../heartbeat'

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

describe('fetchHeartbeat', () => {
	it('sends the shared-secret header and returns ok on a well-shaped 200', async () => {
		const fetchImpl = vi.fn(async (_url, init) => {
			expect(init?.headers).toMatchObject({ 'X-Heartbeat-Secret': 'sekret' })
			return jsonResponse({ latest_completed_at: '2026-07-02T00:00:00.000Z', minutes_since: 3 })
		}) as unknown as typeof fetch
		const res = await fetchHeartbeat(
			'https://app.example/api/internal/fleet-heartbeat',
			'sekret',
			fetchImpl,
		)
		expect(res.kind).toBe('ok')
		if (res.kind === 'ok') {
			expect(res.body.minutes_since).toBe(3)
		}
	})

	it('classifies a 5xx as non_2xx', async () => {
		const fetchImpl = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch
		const res = await fetchHeartbeat('https://x', 's', fetchImpl)
		expect(res.kind).toBe('non_2xx')
		if (res.kind === 'non_2xx') expect(res.status).toBe(503)
	})

	it('classifies a 401 as non_2xx', async () => {
		const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
		const res = await fetchHeartbeat('https://x', 's', fetchImpl)
		expect(res.kind).toBe('non_2xx')
	})

	it('classifies a thrown fetch as network_error', async () => {
		const fetchImpl = (async () => {
			throw new Error('ECONNREFUSED')
		}) as unknown as typeof fetch
		const res = await fetchHeartbeat('https://x', 's', fetchImpl)
		expect(res.kind).toBe('network_error')
		if (res.kind === 'network_error') expect(res.message).toBe('ECONNREFUSED')
	})

	it('classifies a malformed body as malformed', async () => {
		const fetchImpl = (async () => jsonResponse({ wrong: 'shape' })) as unknown as typeof fetch
		const res = await fetchHeartbeat('https://x', 's', fetchImpl)
		expect(res.kind).toBe('malformed')
	})

	it('accepts null fields per the T1 contract (empty sessions table)', async () => {
		const fetchImpl = (async () =>
			jsonResponse({ latest_completed_at: null, minutes_since: null })) as unknown as typeof fetch
		const res = await fetchHeartbeat('https://x', 's', fetchImpl)
		expect(res.kind).toBe('ok')
		if (res.kind === 'ok') {
			expect(res.body.latest_completed_at).toBeNull()
			expect(res.body.minutes_since).toBeNull()
		}
	})
})
