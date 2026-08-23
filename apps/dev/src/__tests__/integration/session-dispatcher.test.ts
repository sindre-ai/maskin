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
})
