import { agentServers } from '@maskin/db/schema'
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
