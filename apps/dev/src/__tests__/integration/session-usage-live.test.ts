import { events, agentServers, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { SESSION_RESUMED_LOG } from '../../services/usage-parser'
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

// One turn's result line. The CLI reports tokens for the turn alone and
// total_cost_usd as the running total of the process.
function turn(n: number, costSoFar: number) {
	return `${JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: `turn ${n}`,
		duration_ms: 1000 * n,
		total_cost_usd: costSoFar,
		usage: {
			input_tokens: 10 * n,
			output_tokens: 100 * n,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	})}\n`
}

// A running chat used to show zero tokens and zero cost until it settled. Each turn's usage is
// now saved as the turn closes, and every settle path adds only what is not saved yet.
describe('Usage is saved turn by turn while a session runs (Integration)', () => {
	let workspaceId: string
	let actorId: string
	let serverId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		await sql`TRUNCATE agent_servers CASCADE`
		const [server] = await db
			.insert(agentServers)
			.values({
				url: 'https://live-usage-under-test.maskin.test:3001',
				secret: 'x'.repeat(32),
				maxConcurrentSessions: 10,
				status: 'active',
			})
			.returning()
		if (!server) throw new Error('failed to insert agent server')
		serverId = server.id
	})

	async function runningSession() {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: serverId,
			containerId: 'sandbox-live-usage',
			startedAt: new Date(),
			timeoutAt: null,
		})
		if (!session) throw new Error('no session')
		return session
	}

	async function withManager<T>(run: (manager: SessionManager) => Promise<T>): Promise<T> {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		})
		const manager = new SessionManager(db, stubStorage())
		try {
			return await run(manager)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}
	}

	async function readRow(id: string) {
		const [row] = await db.select().from(sessions).where(eq(sessions.id, id))
		return row
	}

	const append = (manager: SessionManager, id: string, content: string) =>
		manager.appendRemoteSessionLogs(id, [{ stream: 'stdout', content }])

	it('shows each turn as it closes, while the session is still running', async () => {
		const session = await runningSession()
		await withManager(async (manager) => {
			await append(manager, session.id, turn(1, 0.1))
			let row = await readRow(session.id)
			expect(row?.status).toBe('running')
			expect(row?.inputTokens).toBe(10)
			expect(row?.outputTokens).toBe(100)
			expect(Number(row?.totalCostUsd)).toBeCloseTo(0.1, 6)

			await append(manager, session.id, turn(2, 0.3))
			row = await readRow(session.id)
			// Tokens add up per turn; the cost is the increment of the process's running total.
			expect(row?.inputTokens).toBe(30)
			expect(row?.outputTokens).toBe(300)
			expect(Number(row?.totalCostUsd)).toBeCloseTo(0.3, 6)
		})
	})

	it('records a session event per turn so the web app refetches', async () => {
		const session = await runningSession()
		await withManager((manager) => append(manager, session.id, turn(1, 0.1)))
		const rows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, session.id), eq(events.action, 'session_updated')))
		expect(rows).toHaveLength(1)
	})

	it('adds nothing more when the session settles after its turns were saved live', async () => {
		const session = await runningSession()
		await withManager(async (manager) => {
			await append(manager, session.id, turn(1, 0.1))
			await append(manager, session.id, turn(2, 0.3))
			await manager.markRemoteSessionComplete(session.id, 0)
		})
		const row = await readRow(session.id)
		expect(row?.status).toBe('completed')
		expect(row?.inputTokens).toBe(30)
		expect(row?.outputTokens).toBe(300)
		expect(row?.durationMs).toBe(3000)
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.3, 6)
	})

	it('settle adds a turn that was never saved live, exactly once', async () => {
		const session = await runningSession()
		await withManager(async (manager) => {
			await append(manager, session.id, turn(1, 0.1))
			// Written straight into the logs, as if the live write had failed for this turn.
			await insertSessionLog(db, session.id, { content: turn(2, 0.3) })
			await manager.markRemoteSessionComplete(session.id, 0)
		})
		const row = await readRow(session.id)
		expect(row?.inputTokens).toBe(30)
		expect(row?.outputTokens).toBe(300)
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.3, 6)
	})

	it('restarts the cost base after a resume, whose CLI process starts again from zero', async () => {
		const session = await runningSession()
		await withManager(async (manager) => {
			await append(manager, session.id, turn(1, 0.1))
			await insertSessionLog(db, session.id, { stream: 'system', content: SESSION_RESUMED_LOG })
			// The new process reports its own running total from zero.
			await append(manager, session.id, turn(2, 0.05))
		})
		const row = await readRow(session.id)
		expect(row?.inputTokens).toBe(30)
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.15, 6)
	})

	it('does not add usage to a session that has already settled', async () => {
		const session = await runningSession()
		await withManager(async (manager) => {
			await append(manager, session.id, turn(1, 0.1))
			await manager.markRemoteSessionComplete(session.id, 0)
			await append(manager, session.id, turn(2, 0.3))
		})
		const row = await readRow(session.id)
		expect(row?.inputTokens).toBe(10)
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.1, 6)
	})
})
