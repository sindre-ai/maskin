import { describe, expect, it, vi } from 'vitest'
import {
	AgentServerAuthError,
	type AgentServerClient,
	AgentServerHttpError,
	type AgentServerRow,
	type StartSessionRequest,
	type StartSessionResponse,
} from '../../services/agent-server-client'
import { SessionDispatcher } from '../../services/session-dispatcher'

type ServerStub = AgentServerRow & { max: number }

type SessionStub = {
	id: string
	status: string
	agentServerId: string | null
	containerId: string | null
	startedAt: Date | null
}

function fakeDb(servers: ServerStub[], sessionsRows: SessionStub[]) {
	const sessionsById = new Map(sessionsRows.map((s) => [s.id, s]))

	// pickLeastLoadedServer issues .select({...}).from(agentServers).where(...).
	// We satisfy that one shape and compute `active` from sessionsRows directly.
	const select = (_columns?: Record<string, unknown>) => ({
		from: (_table: unknown) => ({
			where: (_predicate: unknown) =>
				servers
					.filter((s) => (s.status as unknown as string) === 'active')
					.map((s) => {
						const active = sessionsRows.filter(
							(row) =>
								row.agentServerId === s.id &&
								(row.status === 'starting' || row.status === 'running'),
						).length
						return {
							id: s.id,
							url: s.url,
							secret: s.secret,
							max: s.max,
							active,
						}
					}),
		}),
	})

	// The dispatcher issues three distinct UPDATEs against `sessions`:
	//   1. claimSlot     — set agentServerId=<string> (no status, no containerId)
	//   2. markDispatched — set status='running' + containerId
	//   3. releaseSlot   — set agentServerId=null
	// Route each by patch content; the fake holds one row per session_id and
	// applies the patch when the row is in a state the real WHERE would match.
	const update = (_table: unknown) => ({
		set: (patch: Record<string, unknown>) => ({
			where: (_predicate: unknown) => {
				const apply = (): Array<{ id: string }> => {
					const updated: Array<{ id: string }> = []
					for (const row of sessionsById.values()) {
						if (
							typeof patch.agentServerId === 'string' &&
							patch.status === undefined &&
							patch.containerId === undefined
						) {
							// claimSlot: dispatchable + (NULL or already pinned to serverId)
							const dispatchable =
								row.status === 'pending' || row.status === 'queued' || row.status === 'starting'
							if (
								dispatchable &&
								(row.agentServerId === null || row.agentServerId === patch.agentServerId)
							) {
								row.agentServerId = patch.agentServerId
								updated.push({ id: row.id })
								break
							}
						} else if (patch.status === 'running') {
							// markDispatched: row was just claimed
							if (row.agentServerId && row.status !== 'running') {
								row.status = 'running'
								row.containerId = (patch.containerId as string) ?? row.containerId
								row.startedAt = new Date()
								updated.push({ id: row.id })
								break
							}
						} else if (patch.agentServerId === null) {
							// releaseSlot: undo claim
							if (row.agentServerId) {
								row.agentServerId = null
								updated.push({ id: row.id })
								break
							}
						}
					}
					return updated
				}
				const promise = Promise.resolve().then(() => {
					apply()
				}) as Promise<unknown> & {
					returning: (proj?: unknown) => Promise<Array<{ id: string }>>
				}
				promise.returning = (_proj?: unknown) => Promise.resolve(apply())
				return promise
			},
		}),
	})

	return {
		select,
		update,
		_sessions: sessionsById,
	}
}

function defaultStartReq(sessionId: string): StartSessionRequest {
	return { sessionId, image: 'agent-base:latest', env: { SESSION_ID: sessionId } }
}

function startResponse(sessionId: string): StartSessionResponse {
	return {
		sessionId,
		sandboxName: `sb-${sessionId}`,
		connection: { host: 'agent-finland.maskin.test', port: 3001 },
	}
}

function makeClient(impl: Partial<AgentServerClient> = {}): AgentServerClient {
	return {
		startSession: vi.fn(),
		postJson: vi.fn(),
		...impl,
	} as unknown as AgentServerClient
}

describe('SessionDispatcher.pickLeastLoadedServer', () => {
	it('returns null when no active servers exist', async () => {
		const db = fakeDb([], [])
		const dispatcher = new SessionDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: fake DB
			db: db as any,
			buildStartRequest: async () => null,
		})
		await expect(dispatcher.pickLeastLoadedServer()).resolves.toBeNull()
	})

	it('returns null when every active server is at capacity', async () => {
		const servers: ServerStub[] = [
			{ id: 'a', url: 'https://a.test', secret: 'sa', status: 'active' as never, max: 1 },
		]
		const sessionsRows: SessionStub[] = [
			{
				id: 's-pin',
				status: 'running',
				agentServerId: 'a',
				containerId: null,
				startedAt: null,
			},
		]
		const db = fakeDb(servers, sessionsRows)
		const dispatcher = new SessionDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: fake DB
			db: db as any,
			buildStartRequest: async () => null,
		})
		await expect(dispatcher.pickLeastLoadedServer()).resolves.toBeNull()
	})

	it('picks the lowest-load server (load = active / max)', async () => {
		const servers: ServerStub[] = [
			{ id: 'a', url: 'https://a.test', secret: 'sa', status: 'active' as never, max: 10 },
			{ id: 'b', url: 'https://b.test', secret: 'sb', status: 'active' as never, max: 4 },
		]
		// a: 5/10 = 0.5, b: 1/4 = 0.25 → b wins
		const sessionsRows: SessionStub[] = [
			...Array.from({ length: 5 }, (_, i) => ({
				id: `pin-a-${i}`,
				status: 'running',
				agentServerId: 'a',
				containerId: null,
				startedAt: null,
			})),
			{
				id: 'pin-b-0',
				status: 'starting',
				agentServerId: 'b',
				containerId: null,
				startedAt: null,
			},
		]
		const db = fakeDb(servers, sessionsRows)
		const dispatcher = new SessionDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: fake DB
			db: db as any,
			buildStartRequest: async () => null,
		})
		const picked = await dispatcher.pickLeastLoadedServer()
		expect(picked?.server.id).toBe('b')
		expect(picked?.active).toBe(1)
		expect(picked?.max).toBe(4)
	})

	it('breaks load ties by server id ascending', async () => {
		const servers: ServerStub[] = [
			{ id: 'b', url: 'https://b.test', secret: 'sb', status: 'active' as never, max: 4 },
			{ id: 'a', url: 'https://a.test', secret: 'sa', status: 'active' as never, max: 4 },
		]
		const db = fakeDb(servers, [])
		const dispatcher = new SessionDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: fake DB
			db: db as any,
			buildStartRequest: async () => null,
		})
		const picked = await dispatcher.pickLeastLoadedServer()
		expect(picked?.server.id).toBe('a')
	})

	it('counts both starting and running sessions toward load', async () => {
		const servers: ServerStub[] = [
			{ id: 'a', url: 'https://a.test', secret: 'sa', status: 'active' as never, max: 10 },
		]
		const sessionsRows: SessionStub[] = [
			{ id: 'r1', status: 'running', agentServerId: 'a', containerId: null, startedAt: null },
			{ id: 's1', status: 'starting', agentServerId: 'a', containerId: null, startedAt: null },
			// completed should not count
			{ id: 'c1', status: 'completed', agentServerId: 'a', containerId: null, startedAt: null },
		]
		const db = fakeDb(servers, sessionsRows)
		const dispatcher = new SessionDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: fake DB
			db: db as any,
			buildStartRequest: async () => null,
		})
		const picked = await dispatcher.pickLeastLoadedServer()
		expect(picked?.active).toBe(2)
	})

	it('excludes non-active servers (draining, disabled)', async () => {
		const servers: ServerStub[] = [
			{ id: 'a', url: 'https://a.test', secret: 'sa', status: 'draining' as never, max: 10 },
			{ id: 'b', url: 'https://b.test', secret: 'sb', status: 'disabled' as never, max: 10 },
		]
		const db = fakeDb(servers, [])
		const dispatcher = new SessionDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: fake DB
			db: db as any,
			buildStartRequest: async () => null,
		})
		await expect(dispatcher.pickLeastLoadedServer()).resolves.toBeNull()
	})
})

describe('SessionDispatcher.dispatch', () => {
	const SERVER: ServerStub = {
		id: 'srv-1',
		url: 'https://agent-finland.maskin.test:3001',
		secret: 'bearer-secret',
		status: 'active' as never,
		max: 10,
	}

	function setup(sessionsRows: SessionStub[], clientImpl: Partial<AgentServerClient> = {}) {
		const db = fakeDb([SERVER], sessionsRows)
		const client = makeClient(clientImpl)
		const buildStartRequest = vi.fn(async (sessionId: string) => defaultStartReq(sessionId))
		const dispatcher = new SessionDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: fake DB
			db: db as any,
			buildStartRequest,
			clientFactory: () => client,
		})
		return { dispatcher, db, client, buildStartRequest }
	}

	it('returns no_capacity when no server has free capacity', async () => {
		const db = fakeDb(
			[{ ...SERVER, max: 1 }],
			[
				{
					id: 'pin',
					status: 'running',
					agentServerId: SERVER.id,
					containerId: null,
					startedAt: null,
				},
			],
		)
		const client = makeClient()
		const dispatcher = new SessionDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: fake DB
			db: db as any,
			buildStartRequest: async () => defaultStartReq('s'),
			clientFactory: () => client,
		})
		const result = await dispatcher.dispatch('s-new', 'dispatch:s-new')
		expect(result).toEqual({ kind: 'no_capacity' })
		expect(client.startSession).not.toHaveBeenCalled()
	})

	it('dispatches and marks the session running + container=sandboxName on 2xx', async () => {
		const sess: SessionStub = {
			id: 's-1',
			status: 'starting',
			agentServerId: null,
			containerId: null,
			startedAt: null,
		}
		const startSession = vi.fn(async (_req: StartSessionRequest) => startResponse('s-1'))
		const { dispatcher, client } = setup([sess], { startSession })

		const result = await dispatcher.dispatch('s-1', 'dispatch:s-1')

		expect(result).toEqual({ kind: 'dispatched' })
		expect(client.startSession).toHaveBeenCalledTimes(1)
		expect(client.startSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-1' }))
		expect(sess.agentServerId).toBe(SERVER.id)
		expect(sess.status).toBe('running')
		expect(sess.containerId).toBe('sb-s-1')
	})

	it('maps 401 to permanent_failure and releases the slot', async () => {
		const sess: SessionStub = {
			id: 's-1',
			status: 'starting',
			agentServerId: null,
			containerId: null,
			startedAt: null,
		}
		const startSession = vi.fn(async () => {
			throw new AgentServerAuthError({ id: SERVER.id, url: SERVER.url })
		})
		const { dispatcher } = setup([sess], { startSession })

		const result = await dispatcher.dispatch('s-1', 'dispatch:s-1')

		expect(result.kind).toBe('permanent_failure')
		if (result.kind === 'permanent_failure') {
			expect(result.error).toContain('rejected bearer token')
		}
		// slot released so another dispatcher can re-pick this server
		expect(sess.agentServerId).toBeNull()
		expect(sess.status).toBe('starting')
	})

	it('maps generic HTTP failures to transient_failure and releases the slot', async () => {
		const sess: SessionStub = {
			id: 's-1',
			status: 'starting',
			agentServerId: null,
			containerId: null,
			startedAt: null,
		}
		const startSession = vi.fn(async () => {
			throw new AgentServerHttpError({ id: SERVER.id, url: SERVER.url }, 503, 'unavailable')
		})
		const { dispatcher } = setup([sess], { startSession })

		const result = await dispatcher.dispatch('s-1', 'dispatch:s-1')

		expect(result.kind).toBe('transient_failure')
		if (result.kind === 'transient_failure') {
			expect(result.error).toContain('503')
		}
		expect(sess.agentServerId).toBeNull()
	})

	it('returns permanent_failure when buildStartRequest returns null', async () => {
		const sess: SessionStub = {
			id: 's-1',
			status: 'starting',
			agentServerId: null,
			containerId: null,
			startedAt: null,
		}
		const startSession = vi.fn()
		const { dispatcher, buildStartRequest } = setup([sess], { startSession })
		buildStartRequest.mockResolvedValueOnce(null)

		const result = await dispatcher.dispatch('s-1', 'dispatch:s-1')

		expect(result.kind).toBe('permanent_failure')
		expect(startSession).not.toHaveBeenCalled()
		// slot released
		expect(sess.agentServerId).toBeNull()
	})

	it('returns transient_failure when buildStartRequest throws', async () => {
		const sess: SessionStub = {
			id: 's-1',
			status: 'starting',
			agentServerId: null,
			containerId: null,
			startedAt: null,
		}
		const startSession = vi.fn()
		const { dispatcher, buildStartRequest } = setup([sess], { startSession })
		buildStartRequest.mockRejectedValueOnce(new Error('LLM routing blew up'))

		const result = await dispatcher.dispatch('s-1', 'dispatch:s-1')

		expect(result.kind).toBe('transient_failure')
		expect(startSession).not.toHaveBeenCalled()
		expect(sess.agentServerId).toBeNull()
	})
})
