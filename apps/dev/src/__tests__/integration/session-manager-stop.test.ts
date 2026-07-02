import { events, agentServers, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

async function insertAgentServer(overrides: { url?: string } = {}) {
	const [row] = await db
		.insert(agentServers)
		.values({
			url: overrides.url ?? 'https://agent-under-test.maskin.test:3001',
			secret: 'x'.repeat(32),
			maxConcurrentSessions: 10,
			status: 'active',
		})
		.returning()
	return row
}

// Regression coverage for the stop_session routing bug: SessionManager.stopSession
// used to reach for the local Docker ContainerManager unconditionally, so a
// session dispatched to a remote agent-server (agentServerId set) failed with a
// Docker "no such container" error and the DB row was never updated. These tests
// exercise the fixed routing against real Postgres — agentServerId sessions must
// go through AgentServerClient, and the session row must transition to a
// terminal state as a result (never left stuck in "running").
describe('SessionManager.stopSession — remote agent-server routing (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		// global-setup truncates sessions but NOT agent_servers — clear it here.
		await sql`TRUNCATE agent_servers CASCADE`
	})

	it('stops the remote sandbox over HTTP and marks the session failed', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-under-test',
		})

		const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			fetchCalls.push({ url: String(input), init })
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.stopSession(session.id)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		expect(fetchCalls).toHaveLength(1)
		expect(fetchCalls[0]?.url).toBe(`${server.url}/sessions/${session.id}/stop`)
		const headers = new Headers(fetchCalls[0]?.init?.headers)
		expect(headers.get('authorization')).toBe(`Bearer ${server.secret}`)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		expect(row?.completedAt).not.toBeNull()

		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_failed')).toBe(true)
	})

	it('propagates the error and leaves the session row untouched when the agent-server is unreachable', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-unreachable',
		})

		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('boom', { status: 500 }))

		const manager = new SessionManager(db, stubStorage())
		try {
			await expect(manager.stopSession(session.id)).rejects.toThrow()
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('running')
	})

	it('throws without calling Docker when the session has no local container and no agent-server row', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			containerId: null,
			agentServerId: null,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await expect(manager.stopSession(session.id)).rejects.toThrow('not found or has no container')
		} finally {
			await manager.stop()
		}
	})
})
