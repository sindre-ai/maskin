import { agentServers, conversations, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
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

// One turn's result line. The CLI reports tokens and duration for the turn alone
// and total_cost_usd as the running total of the process.
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
			cache_creation_input_tokens: 1000 * n,
			cache_read_input_tokens: 10000 * n,
		},
	})}\n`
}

const LONG_AGO = () => new Date(Date.now() - 35 * 60 * 1000)

// Idle-closed and helper-finished sessions used to settle without saving their
// token totals, so every one of them read as zero tokens and zero cost.
describe('Usage is saved when a session closes idle or a helper finishes (Integration)', () => {
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
				url: 'https://idle-usage-under-test.maskin.test:3001',
				secret: 'x'.repeat(32),
				maxConcurrentSessions: 10,
				status: 'active',
			})
			.returning()
		if (!server) throw new Error('failed to insert agent server')
		serverId = server.id
	})

	async function interactiveSession(overrides: Record<string, unknown> = {}) {
		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Idle usage test', createdBy: actorId })
			.returning()
		if (!conversation) throw new Error('failed to insert conversation')
		return insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			interactive: true,
			conversationId: conversation.id,
			agentServerId: serverId,
			containerId: 'sandbox-idle-usage',
			startedAt: new Date(Date.now() - 40 * 60 * 1000),
			timeoutAt: null,
			...overrides,
		})
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

	const runWatchdog = (manager: SessionManager) =>
		(manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

	async function readRow(id: string) {
		const [row] = await db.select().from(sessions).where(eq(sessions.id, id))
		return row
	}

	it('saves all four token counts, the cost and the duration when a chat closes idle', async () => {
		const session = await interactiveSession()
		if (!session) throw new Error('no session')
		await insertSessionLog(db, session.id, { content: turn(1, 0.1), createdAt: LONG_AGO() })
		await insertSessionLog(db, session.id, { content: turn(2, 0.3), createdAt: LONG_AGO() })
		await insertSessionLog(db, session.id, { content: turn(3, 0.6), createdAt: LONG_AGO() })

		await withManager(runWatchdog)

		const row = await readRow(session.id)
		expect(row?.status).toBe('completed')
		// Tokens and duration are added up over the three turns ...
		expect(row?.inputTokens).toBe(60)
		expect(row?.outputTokens).toBe(600)
		expect(row?.cacheCreationInputTokens).toBe(6000)
		expect(row?.cacheReadInputTokens).toBe(60000)
		expect(row?.durationMs).toBe(6000)
		// ... while the cost is the process's running total, not a sum of running totals.
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.6, 6)
	})

	it('does not count a segment that was already saved at pause', async () => {
		// Segment one ended in a pause that saved turn 1 (10 in, 100 out, $0.1).
		const session = await interactiveSession({
			inputTokens: 10,
			outputTokens: 100,
			cacheCreationInputTokens: 1000,
			cacheReadInputTokens: 10000,
			durationMs: 1000,
			totalCostUsd: '0.1',
		})
		if (!session) throw new Error('no session')
		await insertSessionLog(db, session.id, { content: turn(1, 0.1), createdAt: LONG_AGO() })
		await insertSessionLog(db, session.id, {
			stream: 'system',
			content: 'Session paused and snapshot saved',
			createdAt: LONG_AGO(),
		})
		await insertSessionLog(db, session.id, {
			stream: 'system',
			content: SESSION_RESUMED_LOG,
			createdAt: LONG_AGO(),
		})
		// The relaunched process starts its own tally: two turns, cost from zero.
		await insertSessionLog(db, session.id, { content: turn(2, 0.2), createdAt: LONG_AGO() })
		await insertSessionLog(db, session.id, { content: turn(3, 0.5), createdAt: LONG_AGO() })

		await withManager(runWatchdog)

		const row = await readRow(session.id)
		expect(row?.status).toBe('completed')
		// Pause's 10 + the resumed segment's 20 + 30; turn 1 is not added a second time.
		expect(row?.inputTokens).toBe(60)
		expect(row?.outputTokens).toBe(600)
		expect(row?.cacheCreationInputTokens).toBe(6000)
		expect(row?.cacheReadInputTokens).toBe(60000)
		expect(row?.durationMs).toBe(6000)
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.6, 6)
	})

	it('closes a chat that never finished a turn without inventing usage', async () => {
		const session = await interactiveSession()
		if (!session) throw new Error('no session')
		await insertSessionLog(db, session.id, { content: 'booting\n', createdAt: LONG_AGO() })

		await withManager(runWatchdog)

		const row = await readRow(session.id)
		expect(row?.status).toBe('completed')
		expect(row?.inputTokens).toBeNull()
		expect(row?.outputTokens).toBeNull()
		expect(row?.totalCostUsd).toBeNull()
	})

	it('saves the usage when a helper finishes with its result', async () => {
		const session = await interactiveSession({
			conversationId: null,
			config: { interactive: true, stop_on_result: true },
		})
		if (!session) throw new Error('no session')
		await insertSessionLog(db, session.id, { content: turn(1, 0.25) })

		await withManager((manager) =>
			manager.finishHelperSession(session.id, { isError: false, text: 'done' }),
		)

		const row = await readRow(session.id)
		expect(row?.status).toBe('completed')
		expect(row?.inputTokens).toBe(10)
		expect(row?.outputTokens).toBe(100)
		expect(row?.cacheCreationInputTokens).toBe(1000)
		expect(row?.cacheReadInputTokens).toBe(10000)
		expect(row?.durationMs).toBe(1000)
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.25, 6)
	})

	it('saves the usage when a helper finishes with an error', async () => {
		const session = await interactiveSession({
			conversationId: null,
			config: { interactive: true, stop_on_result: true },
		})
		if (!session) throw new Error('no session')
		await insertSessionLog(db, session.id, { content: turn(1, 0.25) })

		await withManager((manager) =>
			manager.finishHelperSession(session.id, { isError: true, text: 'boom' }),
		)

		const row = await readRow(session.id)
		expect(row?.status).toBe('failed')
		expect(row?.outputTokens).toBe(100)
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.25, 6)
	})

	it('settles a chat that ends on a limit error as failed with the reason and no retry time', async () => {
		const session = await interactiveSession({ config: { interactive: true } })
		if (!session) throw new Error('no session')
		await insertSessionLog(db, session.id, { content: turn(1, 0.25) })

		await withManager((manager) =>
			manager.finishHelperSession(
				session.id,
				{
					isError: true,
					text: "You've hit your session limit · resets 2:20pm (Europe/Copenhagen)",
				},
				{ retry: false },
			),
		)

		const row = await readRow(session.id)
		expect(row?.status).toBe('failed')
		expect(row?.result).toMatchObject({
			failure_reason: { provider: 'anthropic', reason_code: 'session_limit' },
		})
		expect(row?.retryAt).toBeNull()
	})
})
