import { describe, expect, it, vi } from 'vitest'
import {
	AgentServerAuthError,
	AgentServerClient,
	AgentServerHttpError,
	type AgentServerRow,
} from '../../services/agent-server-client'

const SERVER: AgentServerRow = {
	id: '00000000-0000-0000-0000-000000000001',
	url: 'https://agent-finland.maskin.test:3001',
	secret: 'test-bearer-secret-thirty-two-chars-long',
}

function makeFetchSpy(response: Response): {
	fetchImpl: typeof fetch
	calls: Array<{ url: string; init: RequestInit | undefined }>
} {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = []
	const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init })
		return response
	}) as typeof fetch
	return { fetchImpl, calls }
}

describe('AgentServerClient.startSession', () => {
	it('sets Authorization: Bearer <secret> on every dispatch', async () => {
		const { fetchImpl, calls } = makeFetchSpy(
			new Response(
				JSON.stringify({
					sessionId: 's1',
					sandboxName: 's1',
					connection: { host: 'agent-finland.maskin.test', port: 3001 },
				}),
				{ status: 201, headers: { 'content-type': 'application/json' } },
			),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		await client.startSession({ sessionId: 's1', image: 'alpine:3.20' })

		expect(calls).toHaveLength(1)
		const headers = new Headers(calls[0]?.init?.headers)
		expect(headers.get('authorization')).toBe(`Bearer ${SERVER.secret}`)
		expect(headers.get('content-type')).toBe('application/json')
	})

	it('POSTs the JSON body to /sessions at the server URL', async () => {
		const { fetchImpl, calls } = makeFetchSpy(
			new Response(
				JSON.stringify({
					sessionId: 's1',
					sandboxName: 's1',
					connection: { host: 'agent-finland.maskin.test', port: 3001 },
				}),
				{ status: 201, headers: { 'content-type': 'application/json' } },
			),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		const req = { sessionId: 's1', image: 'alpine:3.20', env: { FOO: 'bar' } }
		await client.startSession(req)

		expect(calls[0]?.url).toBe('https://agent-finland.maskin.test:3001/sessions')
		expect(calls[0]?.init?.method).toBe('POST')
		expect(calls[0]?.init?.body).toBe(JSON.stringify(req))
	})

	it('returns the parsed response on 2xx', async () => {
		const payload = {
			sessionId: 's1',
			sandboxName: 's1',
			connection: { host: 'agent-finland.maskin.test', port: 3001 },
			env_overflow_spilled: 0,
			env_sanitized: 0,
		}
		const { fetchImpl } = makeFetchSpy(
			new Response(JSON.stringify(payload), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		await expect(client.startSession({ sessionId: 's1', image: 'alpine:3.20' })).resolves.toEqual(
			payload,
		)
	})

	it('throws AgentServerAuthError on 401', async () => {
		const { fetchImpl } = makeFetchSpy(
			new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		await expect(client.startSession({ sessionId: 's1', image: 'alpine:3.20' })).rejects.toThrow(
			AgentServerAuthError,
		)
	})

	it('throws AgentServerHttpError with the body on non-2xx', async () => {
		const { fetchImpl } = makeFetchSpy(
			new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		try {
			await client.startSession({ sessionId: 's1', image: 'alpine:3.20' })
			expect.fail('expected AgentServerHttpError')
		} catch (err) {
			expect(err).toBeInstanceOf(AgentServerHttpError)
			expect((err as AgentServerHttpError).status).toBe(500)
			expect((err as AgentServerHttpError).body).toBe('boom')
		}
	})

	it('joins URLs cleanly when the server URL has a trailing slash', async () => {
		const { fetchImpl, calls } = makeFetchSpy(
			new Response(
				JSON.stringify({
					sessionId: 's1',
					sandboxName: 's1',
					connection: { host: 'agent-finland.maskin.test', port: 3001 },
				}),
				{ status: 201, headers: { 'content-type': 'application/json' } },
			),
		)
		const client = new AgentServerClient({
			server: { ...SERVER, url: 'https://agent-finland.maskin.test:3001/' },
			fetchImpl,
		})

		await client.startSession({ sessionId: 's1', image: 'alpine:3.20' })

		expect(calls[0]?.url).toBe('https://agent-finland.maskin.test:3001/sessions')
	})

	it('falls back to globalThis.fetch when no fetchImpl is injected', async () => {
		const responsePayload = {
			sessionId: 's2',
			sandboxName: 's2',
			connection: { host: 'agent-finland.maskin.test', port: 3001 },
		}
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(responsePayload), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			}),
		)
		try {
			const client = new AgentServerClient({ server: SERVER })
			await client.startSession({ sessionId: 's2', image: 'alpine:3.20' })
			expect(fetchSpy).toHaveBeenCalledTimes(1)
		} finally {
			fetchSpy.mockRestore()
		}
	})
})

describe('AgentServerClient.postJson', () => {
	it('exposes the same bearer + JSON plumbing for arbitrary sub-paths', async () => {
		const { fetchImpl, calls } = makeFetchSpy(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		const body = await client.postJson<{ ok: boolean }>('/sessions/s1/stop', {})

		expect(body).toEqual({ ok: true })
		expect(calls[0]?.url).toBe('https://agent-finland.maskin.test:3001/sessions/s1/stop')
		const headers = new Headers(calls[0]?.init?.headers)
		expect(headers.get('authorization')).toBe(`Bearer ${SERVER.secret}`)
	})
})
