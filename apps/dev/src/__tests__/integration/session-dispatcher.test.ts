import { agentServers, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import type { AgentServerClient, StartSessionRequest } from '../../services/agent-server-client'
import { SessionDispatcher } from '../../services/session-dispatcher'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// These tests exercise pickLeastLoadedServer's load SQL against a real Postgres.
// buildStartRequest is never reached (no agent-server HTTP), so it returns null.
const makeDispatcher = () => new SessionDispatcher({ db, buildStartRequest: async () => null })

async function insertServer(opts: { url: string; max: number; status?: string }) {
	const [row] = await db
		.insert(agentServers)
		.values({
			url: opts.url,
			secret: 'x'.repeat(32),
			maxConcurrentSessions: opts.max,
			status: opts.status ?? 'active',
		})
		.returning()
	return row
}

describe('SessionDispatcher.pickLeastLoadedServer Integration', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		// global-setup truncates sessions but NOT agent_servers — clear it here.
		await sql`TRUNCATE agent_servers CASCADE`
	})

	/**
	 * Regression for the unqualified-correlation bug (PR #714): the load subquery
	 * rendered `WHERE agent_server_id = id`, and Postgres bound the bare `id` to
	 * the inner `sessions.id` instead of the outer `agent_servers.id`. The
	 * predicate was never true, so COUNT was always 0 — capacity was never
	 * enforced and routing collapsed to the lowest server id. This asserts the
	 * count reflects the sessions actually pinned to the server.
	 */
	it('counts only active (starting/running) sessions pinned to the server', async () => {
		const srv = await insertServer({ url: 'http://srv-a:3001', max: 50 })
		for (const status of ['running', 'running', 'starting']) {
			await insertSession(db, workspaceId, actorId, actorId, { status, agentServerId: srv.id })
		}
		// A completed session and an unpinned running session must NOT be counted.
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			agentServerId: srv.id,
		})
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: null,
		})

		const picked = await makeDispatcher().pickLeastLoadedServer()
		expect(picked?.server.id).toBe(srv.id)
		expect(picked?.active).toBe(3)
	})

	it('excludes a server whose active sessions have reached max_concurrent_sessions', async () => {
		const full = await insertServer({ url: 'http://full:3001', max: 1 })
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: full.id,
		})
		expect(await makeDispatcher().pickLeastLoadedServer()).toBeNull()
	})

	it('excludes a server with max_concurrent_sessions = 0', async () => {
		await insertServer({ url: 'http://zero:3001', max: 0 })
		expect(await makeDispatcher().pickLeastLoadedServer()).toBeNull()
	})

	it('excludes servers that are not active (draining / disabled)', async () => {
		await insertServer({ url: 'http://draining:3001', max: 10, status: 'draining' })
		await insertServer({ url: 'http://disabled:3001', max: 10, status: 'disabled' })
		expect(await makeDispatcher().pickLeastLoadedServer()).toBeNull()
	})

	it('picks the least-loaded server when several have capacity', async () => {
		const heavy = await insertServer({ url: 'http://heavy:3001', max: 10 })
		const light = await insertServer({ url: 'http://light:3001', max: 10 })
		for (let i = 0; i < 5; i++) {
			await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				agentServerId: heavy.id,
			})
		}
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: light.id,
		})

		const picked = await makeDispatcher().pickLeastLoadedServer()
		expect(picked?.server.id).toBe(light.id)
		expect(picked?.active).toBe(1)
	})
})

describe('SessionDispatcher.dispatch — sticky retry Integration', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		// global-setup truncates sessions but NOT agent_servers — clear it here.
		await sql`TRUNCATE agent_servers CASCADE`
	})

	function makeClient(): AgentServerClient {
		const startSession = vi.fn(async (req: StartSessionRequest) => ({
			sessionId: req.sessionId,
			sandboxName: `sb-${req.sessionId}`,
			connection: { host: 'agent.test', port: 3001 },
		}))
		return { startSession, postJson: vi.fn() } as unknown as AgentServerClient
	}

	/**
	 * Regression for MASKIN-DEV-6: a dispatch attempt that claimed a slot on
	 * server A and was then interrupted (e.g. a deploy restart) leaves the
	 * session pinned to A with no matching agent_servers change. A naive retry
	 * that re-runs pickLeastLoadedServer() would choose B (emptier) and get
	 * rejected by claimSlot's same-server check, wrongly reporting a
	 * permanent_failure. The dispatcher must retry against the server the
	 * session is already pinned to.
	 */
	it('retries against the already-pinned server instead of a less-loaded one', async () => {
		const pinned = await insertServer({ url: 'http://pinned:3001', max: 10 })
		// An emptier server exists so a fresh pickLeastLoadedServer() would
		// clearly prefer it over `pinned` — proving the retry stays sticky.
		await insertServer({ url: 'http://emptier:3001', max: 10 })
		for (let i = 0; i < 5; i++) {
			await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				agentServerId: pinned.id,
			})
		}
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			agentServerId: pinned.id,
		})

		const client = makeClient()
		const dispatcher = new SessionDispatcher({
			db,
			buildStartRequest: async (sessionId) => ({
				sessionId,
				image: 'agent-base:latest',
				env: { SESSION_ID: sessionId },
			}),
			clientFactory: () => client,
		})

		const result = await dispatcher.dispatch(session.id, `dispatch:${session.id}`)

		expect(result).toEqual({ kind: 'dispatched' })
		expect(client.startSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: session.id }),
		)
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated.agentServerId).toBe(pinned.id)
		expect(updated.status).toBe('running')
	})

	// A row that waited in the capacity queue keeps session_state='queued' until
	// the drain really dispatches it; the dispatcher's write is what takes it to
	// running, with the sandbox name as its containerId.
	it('takes a drained queued row to session_state=running with a containerId', async () => {
		await insertServer({ url: 'http://drain:3001', max: 10 })
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			sessionState: 'queued',
			containerId: null,
			startedAt: null,
		})

		const dispatcher = new SessionDispatcher({
			db,
			buildStartRequest: async (sessionId) => ({
				sessionId,
				image: 'agent-base:latest',
				env: { SESSION_ID: sessionId },
			}),
			clientFactory: () => makeClient(),
		})

		const result = await dispatcher.dispatch(session.id, `dispatch:${session.id}`)

		expect(result).toEqual({ kind: 'dispatched' })
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated.status).toBe('running')
		expect(updated.sessionState).toBe('running')
		expect(updated.containerId).toBe(`sb-${session.id}`)
	})

	/**
	 * getStickyAssignment() must not honor a pin to a server the operator has
	 * since taken out of rotation — a bare `agent_servers.id` lookup with no
	 * status filter would otherwise route a brand-new session start to a
	 * server intentionally being drained/disabled, unlike
	 * pickLeastLoadedServer()'s `status = 'active'` filter.
	 */
	it('falls back to a fresh active server when the pinned server has been drained', async () => {
		const drained = await insertServer({ url: 'http://drained:3001', max: 10 })
		const fresh = await insertServer({ url: 'http://fresh:3001', max: 10 })
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			agentServerId: drained.id,
		})
		// Operator drains the server after the session was pinned but before the retry.
		await db.update(agentServers).set({ status: 'draining' }).where(eq(agentServers.id, drained.id))

		const client = makeClient()
		const dispatcher = new SessionDispatcher({
			db,
			buildStartRequest: async (sessionId) => ({
				sessionId,
				image: 'agent-base:latest',
				env: { SESSION_ID: sessionId },
			}),
			clientFactory: () => client,
		})

		const result = await dispatcher.dispatch(session.id, `dispatch:${session.id}`)

		expect(result).toEqual({ kind: 'dispatched' })
		expect(client.startSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: session.id }),
		)
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated.agentServerId).toBe(fresh.id)
		expect(updated.status).toBe('running')
	})

	/**
	 * markDispatched used to guard on status NOT IN ('completed','failed'), so a
	 * row that was paused (or timed out) while startSession was in flight was
	 * resurrected to running, and a terminal row was left as-is while the
	 * sandbox startSession had just created kept running with no owner.
	 */
	async function dispatchWhileStatusChanges(newStatus: string) {
		await insertServer({ url: 'http://srv:3001', max: 10 })
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			agentServerId: null,
		})
		const stopSession = vi.fn(async () => ({ stopped: 'sandbox-stopped' as const }))
		const startSession = vi.fn(async (req: StartSessionRequest) => {
			await db.update(sessions).set({ status: newStatus }).where(eq(sessions.id, session.id))
			return {
				sessionId: req.sessionId,
				sandboxName: `sb-${req.sessionId}`,
				connection: { host: 'agent.test', port: 3001 },
			}
		})
		const client = { startSession, stopSession, postJson: vi.fn() } as unknown as AgentServerClient
		const dispatcher = new SessionDispatcher({
			db,
			buildStartRequest: async (sessionId) => ({
				sessionId,
				image: 'agent-base:latest',
				env: { SESSION_ID: sessionId },
			}),
			clientFactory: () => client,
		})
		const result = await dispatcher.dispatch(session.id, `dispatch:${session.id}`)
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		return { result, row, stopSession, sessionId: session.id }
	}

	it('does not resurrect a paused session to running and does not stop its sandbox', async () => {
		const { result, row, stopSession, sessionId } = await dispatchWhileStatusChanges('paused')

		expect(result.kind).toBe('permanent_failure')
		expect(row.status).toBe('paused')
		expect(row.containerId).not.toBe(`sb-${sessionId}`)
		expect(stopSession).not.toHaveBeenCalled()
	})

	it('stops the orphaned sandbox when the session was already completed', async () => {
		const { result, row, stopSession, sessionId } = await dispatchWhileStatusChanges('completed')

		expect(result.kind).toBe('permanent_failure')
		expect(row.status).toBe('completed')
		expect(row.containerId).not.toBe(`sb-${sessionId}`)
		expect(stopSession).toHaveBeenCalledWith(sessionId, {
			reason: 'stop',
			source: 'dispatch-queue',
		})
	})
})

describe('SessionDispatcher.dispatch — atomic slot claim Integration', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		// global-setup truncates sessions but NOT agent_servers — clear it here.
		await sql`TRUNCATE agent_servers CASCADE`
	})

	function makeClient() {
		const startSession = vi.fn(async (req: StartSessionRequest) => ({
			sessionId: req.sessionId,
			sandboxName: `sb-${req.sessionId}`,
			connection: { host: 'agent.test', port: 3001 },
		}))
		return { startSession, postJson: vi.fn() } as unknown as AgentServerClient & {
			startSession: typeof startSession
		}
	}

	function makeLiveDispatcher(client: AgentServerClient) {
		return new SessionDispatcher({
			db,
			buildStartRequest: async (sessionId) => ({
				sessionId,
				image: 'agent-base:latest',
				env: { SESSION_ID: sessionId },
			}),
			clientFactory: () => client,
		})
	}

	async function countHeld(serverId: string): Promise<number> {
		const [row] = await sql`
			SELECT COUNT(*)::int AS held FROM sessions
			WHERE agent_server_id = ${serverId} AND status IN ('starting','running')`
		return row.held
	}

	async function insertQueuedSessions(n: number) {
		const rows = []
		for (let i = 0; i < n; i++) {
			rows.push(
				await insertSession(db, workspaceId, actorId, actorId, {
					status: 'starting',
					agentServerId: null,
				}),
			)
		}
		return rows
	}

	/**
	 * Regression for the 12 Oct overshoot (running peaked at 20-21 against a cap
	 * of 13): pickLeastLoadedServer and claimSlot were two statements with no
	 * capacity check on the claim, so parallel dispatches that all read "2 free"
	 * all claimed. Every dispatch here is handed the same stale pick, which is
	 * the worst case of that race, and only the free slots may be claimed.
	 */
	it('claims at most the free slots when parallel dispatches share a stale pick', async () => {
		const srv = await insertServer({ url: 'http://cap:3001', max: 5 })
		for (let i = 0; i < 3; i++) {
			await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				agentServerId: srv.id,
			})
		}
		const queued = await insertQueuedSessions(8)

		const client = makeClient()
		const dispatcher = makeLiveDispatcher(client)
		vi.spyOn(dispatcher, 'pickLeastLoadedServer').mockResolvedValue({
			server: { id: srv.id, url: srv.url },
			active: 3,
			max: 5,
		})

		const results = await Promise.all(
			queued.map((s) => dispatcher.dispatch(s.id, `dispatch:${s.id}`)),
		)

		expect(results.filter((r) => r.kind === 'dispatched')).toHaveLength(2)
		expect(results.filter((r) => r.kind === 'no_capacity')).toHaveLength(6)
		expect(client.startSession).toHaveBeenCalledTimes(2)
		expect(await countHeld(srv.id)).toBe(5)
	})

	it('claims exactly the free slots when parallel dispatches pick fresh', async () => {
		const srv = await insertServer({ url: 'http://fresh-cap:3001', max: 5 })
		for (let i = 0; i < 3; i++) {
			await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				agentServerId: srv.id,
			})
		}
		const queued = await insertQueuedSessions(8)

		const client = makeClient()
		const dispatcher = makeLiveDispatcher(client)

		const results = await Promise.all(
			queued.map((s) => dispatcher.dispatch(s.id, `dispatch:${s.id}`)),
		)

		expect(results.filter((r) => r.kind === 'dispatched')).toHaveLength(2)
		expect(results.filter((r) => r.kind === 'no_capacity')).toHaveLength(6)
		expect(client.startSession).toHaveBeenCalledTimes(2)
		expect(await countHeld(srv.id)).toBe(5)
	})

	it('treats a full server as no_capacity and leaves the row unpinned and queued', async () => {
		const srv = await insertServer({ url: 'http://full:3001', max: 1 })
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: srv.id,
		})
		const [session] = await insertQueuedSessions(1)

		const client = makeClient()
		const dispatcher = makeLiveDispatcher(client)
		vi.spyOn(dispatcher, 'pickLeastLoadedServer').mockResolvedValue({
			server: { id: srv.id, url: srv.url },
			active: 0,
			max: 1,
		})

		const result = await dispatcher.dispatch(session.id, `dispatch:${session.id}`)

		expect(result).toEqual({ kind: 'no_capacity' })
		expect(client.startSession).not.toHaveBeenCalled()
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row.agentServerId).toBeNull()
		expect(row.status).toBe('starting')
	})

	it('does not count the session itself when it re-claims the server it is pinned to', async () => {
		const srv = await insertServer({ url: 'http://sticky-cap:3001', max: 1 })
		// Pinned and starting, so already counted: the only slot on the server is its own.
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			agentServerId: srv.id,
		})

		const client = makeClient()
		const result = await makeLiveDispatcher(client).dispatch(session.id, `dispatch:${session.id}`)

		expect(result).toEqual({ kind: 'dispatched' })
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row.agentServerId).toBe(srv.id)
		expect(row.status).toBe('running')
	})

	it('still reports a terminal session as a permanent failure, not as a full server', async () => {
		const srv = await insertServer({ url: 'http://terminal:3001', max: 5 })
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			agentServerId: null,
		})

		const client = makeClient()
		const dispatcher = makeLiveDispatcher(client)
		vi.spyOn(dispatcher, 'pickLeastLoadedServer').mockResolvedValue({
			server: { id: srv.id, url: srv.url },
			active: 0,
			max: 5,
		})

		const result = await dispatcher.dispatch(session.id, `dispatch:${session.id}`)

		expect(result.kind).toBe('permanent_failure')
		expect(client.startSession).not.toHaveBeenCalled()
	})
})
