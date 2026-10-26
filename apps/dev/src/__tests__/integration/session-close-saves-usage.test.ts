import { agentServers, conversations, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * A session that ends by going idle, or because a helper returned its result,
 * must save its token counts and cost before the row turns terminal. Without
 * that the `$ai_generation` event, the billing page and the plan cap all read
 * zero for it.
 */

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

// One CLI process: token counts and duration are each turn's own, while
// total_cost_usd is the process's running total.
function resultLine(turn: { cost: number; input: number; output: number; cacheRead: number }) {
	return `${JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'ok',
		duration_ms: 1000,
		total_cost_usd: turn.cost,
		usage: {
			input_tokens: turn.input,
			output_tokens: turn.output,
			cache_creation_input_tokens: 10,
			cache_read_input_tokens: turn.cacheRead,
		},
	})}\n`
}

describe('Closing a session saves its usage (Integration)', () => {
	let workspaceId: string
	let actorId: string
	let serverUrl: string
	let serverId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		await sql`TRUNCATE agent_servers CASCADE`
		serverUrl = 'https://close-saves-usage.maskin.test:3001'
		const [server] = await db
			.insert(agentServers)
			.values({ url: serverUrl, secret: 'x'.repeat(32), maxConcurrentSessions: 10, status: 'active' })
			.returning()
		if (!server) throw new Error('failed to insert agent server')
		serverId = server.id
	})

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

	function runningChat(overrides: Record<string, unknown> = {}) {
		return insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			interactive: true,
			conversationId: null,
			agentServerId: serverId,
			containerId: 'sandbox-close-saves-usage',
			startedAt: new Date(Date.now() - 40 * 60 * 1000),
			timeoutAt: null,
			config: { llm_route: 'claude_oauth' },
			modelName: 'claude-opus-4-7',
			...overrides,
		})
	}

	it('saves the log usage when a helper returns its result', async () => {
		const session = await runningChat()
		if (!session) throw new Error('no session')
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: resultLine({ cost: 0.5, input: 100, output: 200, cacheRead: 3000 }),
		})

		await withManager((manager) =>
			manager.finishHelperSession(session.id, { isError: false, text: 'done' }),
		)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('completed')
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.5, 6)
		expect(row?.inputTokens).toBe(100)
		expect(row?.outputTokens).toBe(200)
		expect(row?.cacheCreationInputTokens).toBe(10)
		expect(row?.cacheReadInputTokens).toBe(3000)
		expect(row?.durationMs).toBe(1000)
	})

	it('sums the turns of a conversation: tokens add up, cost is the running total', async () => {
		const session = await runningChat()
		if (!session) throw new Error('no session')

		await withManager(async (manager) => {
			// No conversation is attached, so the finalizer only counts the turns.
			await manager.turnFinalizer.onStdout(
				session.id,
				resultLine({ cost: 0.1, input: 10, output: 100, cacheRead: 1000 }),
				1,
			)
			await manager.turnFinalizer.onStdout(
				session.id,
				resultLine({ cost: 0.25, input: 20, output: 300, cacheRead: 2000 }),
				2,
			)
			// The agent-server replays stdout on reconnect: a repeat is not a new turn.
			await manager.turnFinalizer.onStdout(
				session.id,
				resultLine({ cost: 0.25, input: 20, output: 300, cacheRead: 2000 }),
				3,
			)
			await manager.finishHelperSession(session.id, { isError: false, text: 'done' })
		})

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('completed')
		expect(row?.inputTokens).toBe(30)
		expect(row?.outputTokens).toBe(400)
		expect(row?.cacheCreationInputTokens).toBe(20)
		expect(row?.cacheReadInputTokens).toBe(3000)
		expect(row?.durationMs).toBe(2000)
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.25, 6)
	})

	it('hands a segment over once, so a pause and a later close do not count it twice', async () => {
		const session = await runningChat()
		if (!session) throw new Error('no session')

		await withManager(async (manager) => {
			await manager.turnFinalizer.onStdout(
				session.id,
				resultLine({ cost: 0.1, input: 10, output: 100, cacheRead: 1000 }),
				1,
			)
			// What a pause does with the segment it saves.
			expect(manager.turnFinalizer.takeTurnUsage(session.id)?.outputTokens).toBe(100)
			expect(manager.turnFinalizer.takeTurnUsage(session.id)).toBeNull()
		})
	})

	it('saves the log usage when the idle watchdog closes a conversation', async () => {
		const session = await runningChat()
		if (!session) throw new Error('no session')
		const conversationId = await attachConversation(session.id)
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: resultLine({ cost: 0.75, input: 50, output: 60, cacheRead: 7000 }),
			createdAt: new Date(Date.now() - 35 * 60 * 1000),
		})

		await withManager((manager) =>
			(manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog(),
		)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.conversationId).toBe(conversationId)
		expect(row?.status).toBe('completed')
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.75, 6)
		expect(row?.inputTokens).toBe(50)
		expect(row?.outputTokens).toBe(60)
		expect(row?.cacheReadInputTokens).toBe(7000)
	})

	async function attachConversation(sessionId: string): Promise<string> {
		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Close saves usage', createdBy: actorId })
			.returning()
		if (!conversation) throw new Error('failed to insert conversation')
		await db
			.update(sessions)
			.set({ conversationId: conversation.id })
			.where(eq(sessions.id, sessionId))
		return conversation.id
	}
})
