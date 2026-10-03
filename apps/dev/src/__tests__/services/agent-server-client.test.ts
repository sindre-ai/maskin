import type {
	PushAgentFilesRequest,
	PushAgentFilesResponse,
	StopSessionRequest,
	StopSessionResponse,
} from '@maskin/shared'
import { describe, expect, it, vi } from 'vitest'
import {
	AgentServerAuthError,
	AgentServerClient,
	AgentServerHttpError,
	type AgentServerRow,
	STOP_SESSION_TIMEOUT_MS,
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

describe('AgentServerClient.stopSession', () => {
	it('POSTs a body carrying both reason and source to /sessions/:id/stop with bearer auth', async () => {
		const { fetchImpl, calls } = makeFetchSpy(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		await client.stopSession('s1', { reason: 'stop', source: 'user-stop' })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toBe('https://agent-finland.maskin.test:3001/sessions/s1/stop')
		expect(calls[0]?.init?.method).toBe('POST')
		// agent-server answers 400 (invalid_request) when either field is missing.
		const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
		expect(body.reason).toEqual(expect.any(String))
		expect(body.source).toEqual(expect.any(String))
		const headers = new Headers(calls[0]?.init?.headers)
		expect(headers.get('authorization')).toBe(`Bearer ${SERVER.secret}`)
	})

	it('throws AgentServerHttpError on non-2xx', async () => {
		const { fetchImpl } = makeFetchSpy(new Response('boom', { status: 500 }))
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		await expect(client.stopSession('s1', { reason: 'stop', source: 'user-stop' })).rejects.toThrow(
			AgentServerHttpError,
		)
	})

	// The reaper settles boot-stalled rows in series, so a hung agent server
	// must not stall the pass: stop carries an abort signal, dispatch does not
	// (POST /sessions can legitimately run ~70s).
	it('sends an abort signal bounded by STOP_SESSION_TIMEOUT_MS', async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
		const { fetchImpl, calls } = makeFetchSpy(
			new Response(JSON.stringify({ stopped: 'sandbox-stopped' }), { status: 200 }),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		await client.stopSession('s1', { reason: 'fail', source: 'reaper' })

		expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
		expect(timeoutSpy).toHaveBeenCalledWith(STOP_SESSION_TIMEOUT_MS)
		timeoutSpy.mockRestore()
		// Above the agent server's own worst case (list 10s + msb stop 20s),
		// under the 60s reaper tick.
		expect(STOP_SESSION_TIMEOUT_MS).toBeGreaterThan(30_000)
		expect(STOP_SESSION_TIMEOUT_MS).toBeLessThan(60_000)
	})

	it('rejects instead of hanging when the abort signal fires', async () => {
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.signal?.aborted) throw new Error('aborted')
			return new Response('{}', { status: 200 })
		}) as typeof fetch
		const client = new AgentServerClient({ server: SERVER, fetchImpl })
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())

		await expect(client.stopSession('s1', { reason: 'fail', source: 'reaper' })).rejects.toThrow(
			'aborted',
		)
		timeoutSpy.mockRestore()
	})

	it('startSession carries no abort signal', async () => {
		const { fetchImpl, calls } = makeFetchSpy(new Response(JSON.stringify({}), { status: 200 }))
		const client = new AgentServerClient({ server: SERVER, fetchImpl })

		await client.startSession({ sessionId: 's1' } as never)

		expect(calls[0]?.init?.signal).toBeUndefined()
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

// ─────────────────────────────────────────────────────────────────────────────
// Commit 3 — RPC contract tests. Every request/response shape lives in
// `packages/shared/src/agent-storage-layout.ts` (§6.4). This block asserts
// the wire shape both sides agree on; the agent-server handler tests under
// `apps/agent-server/src/__tests__/session-{stop,push-agent-files}.test.ts`
// assert the server side against the same imported types.
//
// The `stopSession` cells below assume the reshape from §2.2 (accepts
// `{ reason, source }`, returns `{ stopped: 'sandbox-stopped'|... }`). At
// commit 2's foundation-slice head, the client method still has the old
// `POST {}` / `{ ok: true }` shape (see the existing suite above). These
// cells are `it.todo(...)` until commit 2's second slice reshapes them —
// they go green when the reshape lands on this branch.
//
// Cross-package type-check: importing the shared types here binds the test's
// literals to §6.4. A rename on the shared side that isn't followed on the
// client side turns into a compile error inside this file, not a silent
// runtime shape drift.
// ─────────────────────────────────────────────────────────────────────────────

describe('RPC contract: POST /sessions/:id/stop (§2.2)', () => {
	// Sanity-check the shared type shapes stay reachable — an accidental
	// tree-shake or path-remap in packages/shared surfaces here at compile time.
	it('shared types compile: StopSessionRequest / StopSessionResponse', () => {
		const req: StopSessionRequest = { reason: 'timeout', source: 'timeout-watchdog' }
		const res: StopSessionResponse = { stopped: 'sandbox-stopped' }
		expect(req.reason).toBe('timeout')
		expect(res.stopped).toBe('sandbox-stopped')
	})

	it('client.stopSession posts the §2.2 shape to /sessions/:id/stop', async () => {
		const { fetchImpl, calls } = makeFetchSpy(
			new Response(JSON.stringify({ stopped: 'sandbox-stopped' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })
		const req: StopSessionRequest = { reason: 'stop', source: 'user-stop' }
		await client.stopSession('sess-stop', req)

		expect(calls[0]?.url).toBe('https://agent-finland.maskin.test:3001/sessions/sess-stop/stop')
		expect(calls[0]?.init?.method).toBe('POST')
		expect(calls[0]?.init?.body).toBe(JSON.stringify(req))
		const headers = new Headers(calls[0]?.init?.headers)
		expect(headers.get('authorization')).toBe(`Bearer ${SERVER.secret}`)
	})

	it('client.stopSession returns { stopped: sandbox-stopped } on 200', async () => {
		const { fetchImpl } = makeFetchSpy(
			new Response(JSON.stringify({ stopped: 'sandbox-stopped' } as StopSessionResponse), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })
		const res = await client.stopSession('sess-1', { reason: 'complete', source: 'sandbox-exit' })
		expect(res).toEqual({ stopped: 'sandbox-stopped' })
	})

	it('client.stopSession returns { stopped: sandbox-already-gone } on the idempotent 200', async () => {
		const { fetchImpl } = makeFetchSpy(
			new Response(JSON.stringify({ stopped: 'sandbox-already-gone' } as StopSessionResponse), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })
		const res = await client.stopSession('sess-2', { reason: 'stop', source: 'user-stop' })
		expect(res.stopped).toBe('sandbox-already-gone')
	})

	it.todo(
		'client.stopSession returns { stopped: sandbox-not-found } (404 body) as the typed outcome, not a throw — needs a client-side 404 translator (not on this branch)',
	)
	it.todo(
		'client.stopSession retries 5xx up to 3 times at 250/500/1000ms and surfaces failure — retry policy not implemented on this branch',
	)
})

describe('RPC contract: POST /sessions/:sessionId/push-agent-files (§7.1)', () => {
	it('shared types compile: PushAgentFilesRequest / PushAgentFilesResponse', () => {
		const req: PushAgentFilesRequest = { directories: ['learnings', 'memory'] }
		const res: PushAgentFilesResponse = {
			pushed: { learnings: { files: 3, bytes: 128 }, memory: { files: 1, bytes: 42 } },
			errors: [],
		}
		expect(req.directories).toEqual(['learnings', 'memory'])
		expect(res.pushed.learnings?.files).toBe(3)
	})

	it('client.pushAgentFiles posts the §7.1 shape to /sessions/:id/push-agent-files', async () => {
		const { fetchImpl, calls } = makeFetchSpy(
			new Response(
				JSON.stringify({
					pushed: { learnings: { files: 3, bytes: 128 }, memory: { files: 1, bytes: 42 } },
					errors: [],
				} satisfies PushAgentFilesResponse),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })
		const req: PushAgentFilesRequest = { directories: ['learnings', 'memory'] }
		await client.pushAgentFiles('sess-push', req)

		expect(calls[0]?.url).toBe(
			'https://agent-finland.maskin.test:3001/sessions/sess-push/push-agent-files',
		)
		expect(calls[0]?.init?.method).toBe('POST')
		expect(calls[0]?.init?.body).toBe(JSON.stringify(req))
	})

	it('client.pushAgentFiles surfaces per-directory errors in errors[] without throwing', async () => {
		const { fetchImpl } = makeFetchSpy(
			new Response(
				JSON.stringify({
					pushed: { learnings: { files: 2, bytes: 90 } },
					errors: [{ directory: 'memory', message: 'ENOENT' }],
				} satisfies PushAgentFilesResponse),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)
		const client = new AgentServerClient({ server: SERVER, fetchImpl })
		const res = await client.pushAgentFiles('sess-push-err', {
			directories: ['learnings', 'memory'],
		})
		expect(res.errors).toEqual([{ directory: 'memory', message: 'ENOENT' }])
		expect(res.pushed.learnings?.files).toBe(2)
		expect(res.pushed.memory).toBeUndefined()
	})

	it.todo(
		'pushAgentFiles() retries up to 5 times with backoff on 5xx (§7.1) — retry policy not implemented on this branch',
	)
})
