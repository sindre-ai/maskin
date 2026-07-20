import { events, agentServers, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
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

	// Regression coverage for the duplicate-audit-event race: markRemoteSessionComplete
	// used to SELECT then UPDATE with no status condition, so two concurrent calls for
	// the same session (a double-click stop, or a stop racing the agent-server's async
	// completion report) could both observe 'running' and both insert a terminal event.
	// The fix makes the UPDATE a compare-and-set (status NOT IN <terminal set> in the
	// WHERE clause); only the winning call's UPDATE matches a row.
	it('two concurrent markRemoteSessionComplete calls for the same session produce exactly one terminal event', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await Promise.all([
				manager.markRemoteSessionComplete(session.id, 1),
				manager.markRemoteSessionComplete(session.id, 1),
			])
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')

		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.filter((e) => e.action === 'session_failed')).toHaveLength(1)
	})

	// Regression coverage for the crash-window race: if apps/dev crashes between
	// AgentServerClient.stopSession() succeeding and stopSession()'s own
	// markRemoteSessionComplete(id, null) call landing, the row is left 'running'
	// until agent-server's monitorSession loop later reports completion. That report
	// now always carries FORCED_STOP_EXIT_CODE (apps/agent-server/src/index.ts) for a
	// forcibly-stopped session instead of a possibly-0 default, so it must still land
	// on 'failed' — never 'completed' — even when it's the only call that ever fires.
	// 137 must match FORCED_STOP_EXIT_CODE in apps/agent-server/src/index.ts.
	it('a forced-stop sentinel exit code lands the session on failed, never completed', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 137)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		expect(row?.result).toMatchObject({ exit_code: 137 })
	})

	// Regression coverage: remote (agent-server) sessions never populated token/cost
	// usage on completion, unlike the local Docker path — the completion handshake
	// only ever carried an exit code. markRemoteSessionComplete now reads the
	// session's stdout tail from session_logs (populated by the agent-server's log
	// ingest endpoint) and extracts usage the same way the local path does.
	it('populates token/cost usage from session_logs on remote completion', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
		})

		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({
				type: 'result',
				total_cost_usd: 0.1234,
				duration_ms: 5000,
				usage: {
					input_tokens: 100,
					output_tokens: 200,
					cache_creation_input_tokens: 10,
					cache_read_input_tokens: 20,
				},
			})}\n`,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('completed')
		expect(row?.totalCostUsd).toBe('0.123400')
		expect(row?.inputTokens).toBe(100)
		expect(row?.outputTokens).toBe(200)
		expect(row?.cacheCreationInputTokens).toBe(10)
		expect(row?.cacheReadInputTokens).toBe(20)
		expect(row?.durationMs).toBe(5000)
	})
})
