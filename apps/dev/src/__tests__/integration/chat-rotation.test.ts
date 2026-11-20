import { agentServers, conversations, messages, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { asc, eq } from 'drizzle-orm'
import { loadRotationHandoff } from '../../services/conversation-responder'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Chat rotation against real Postgres: a chat session that closes a turn over the size line is
 * asked for a handoff note, keeps that note out of the chat, is closed with the note saved on its
 * row, and the next session of that chat reads the note back. The row write (a jsonb merge into
 * sessions.config) and the lookup of the newest session are what a mocked DB cannot check.
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

// Every row ends in a newline, as the agent-server transport writes it: the reader holds a row
// without one back as a partial line.
const assistantLine = (cacheRead: number) =>
	`${JSON.stringify({
		type: 'assistant',
		message: {
			id: 'gen-1',
			role: 'assistant',
			content: [{ type: 'text', text: 'Done.' }],
			usage: {
				input_tokens: 1_000,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: cacheRead,
			},
		},
	})}\n`

const resultLine = (text: string) =>
	`${JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: text,
		usage: { input_tokens: 5, output_tokens: 5 },
		modelUsage: { 'deepseek/deepseek-v4.1-flash': { contextWindow: 1_000_000 } },
	})}\n`

const NOTE =
	'HANDOFF NOTE\nGoal: ship the report\nDecisions: use the Q3 numbers\nStanding rules: never email customers\nOpen items: none'

describe('Chat rotation (Integration)', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string

	beforeEach(async () => {
		const owner = getTestActorId()
		agentId = (await insertActor(db, { type: 'agent', name: 'Rotation agent' })).id
		humanId = owner
		const ws = await insertWorkspace(db, owner)
		workspaceId = ws.id
		await sql`TRUNCATE agent_servers CASCADE`
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	async function seedChat() {
		const [server] = await db
			.insert(agentServers)
			.values({
				url: 'https://rotation-under-test.maskin.test:3001',
				secret: 'x'.repeat(32),
				maxConcurrentSessions: 10,
				status: 'active',
			})
			.returning()
		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Rotation test', createdBy: humanId })
			.returning()
		if (!server || !conversation) throw new Error('seed failed')
		// The agent has the last word, so no message is waiting for an answer.
		await db
			.insert(messages)
			.values({ conversationId: conversation.id, actorId: humanId, content: 'hi' })
		await db
			.insert(messages)
			.values({ conversationId: conversation.id, actorId: agentId, content: 'Done.' })
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			status: 'running',
			interactive: true,
			conversationId: conversation.id,
			agentServerId: server.id,
			containerId: 'sandbox-rotation-test',
			modelName: 'deepseek/deepseek-v4.1-flash',
		})
		return { server, conversation, session }
	}

	function stubAgentServer() {
		const inputs: string[] = []
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			if (String(input).endsWith('/input')) inputs.push(String(init?.body ?? ''))
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		})
		return inputs
	}

	it('asks for a note over the line, keeps it out of the chat, closes with it saved', async () => {
		vi.stubEnv('CHAT_ROTATION_ENABLED', 'true')
		const { conversation, session } = await seedChat()
		const inputs = stubAgentServer()
		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.appendRemoteSessionLogs(session.id, [
				{ stream: 'stdout', content: assistantLine(160_000) },
				{ stream: 'stdout', content: resultLine('Done.') },
			])
			expect(inputs).toHaveLength(1)
			expect(inputs[0]).toContain('HANDOFF NOTE')
			expect(inputs[0]).toContain('Standing rules')

			await manager.appendRemoteSessionLogs(session.id, [
				{ stream: 'stdout', content: resultLine(NOTE) },
			])
			await vi.waitFor(async () => {
				const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
				expect(row?.status).toBe('completed')
			})

			const [closed] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			const rotation = (closed?.config as { rotation?: Record<string, unknown> }).rotation
			expect(rotation).toMatchObject({ reason: 'size', handoff: 'ok', sizeBucket: '150k_200k' })
			expect(rotation?.note).toContain('never email customers')

			// The note is not a reply: nothing in the chat carries it.
			const chat = await db
				.select({ content: messages.content })
				.from(messages)
				.where(eq(messages.conversationId, conversation.id))
				.orderBy(asc(messages.id))
			expect(chat.some((m) => m.content.includes('HANDOFF NOTE'))).toBe(false)
		} finally {
			await manager.stop()
		}
	})

	it('does not ask, and does not close, with the setting off', async () => {
		const { session } = await seedChat()
		const inputs = stubAgentServer()
		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.appendRemoteSessionLogs(session.id, [
				{ stream: 'stdout', content: assistantLine(160_000) },
				{ stream: 'stdout', content: resultLine('Done.') },
			])
			expect(inputs).toHaveLength(0)
			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('running')
		} finally {
			await manager.stop()
		}
	})

	it('does not ask under the line', async () => {
		vi.stubEnv('CHAT_ROTATION_ENABLED', 'true')
		const { session } = await seedChat()
		const inputs = stubAgentServer()
		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.appendRemoteSessionLogs(session.id, [
				{ stream: 'stdout', content: assistantLine(100_000) },
				{ stream: 'stdout', content: resultLine('Done.') },
			])
			expect(inputs).toHaveLength(0)
		} finally {
			await manager.stop()
		}
	})

	describe('loadRotationHandoff', () => {
		it('returns the note of the newest session when it was rotated', async () => {
			const { conversation, session } = await seedChat()
			await db
				.update(sessions)
				.set({
					status: 'completed',
					config: { rotation: { reason: 'size', handoff: 'ok', note: NOTE } },
				})
				.where(eq(sessions.id, session.id))
			const found = await loadRotationHandoff(db, {
				conversationId: conversation.id,
				agentId,
				threadRootId: null,
			})
			expect(found?.note).toBe(NOTE)
		})

		it('returns an empty note for a fallback and nothing once a later session was not rotated', async () => {
			const { conversation, session } = await seedChat()
			await db
				.update(sessions)
				.set({
					status: 'completed',
					config: { rotation: { reason: 'compaction_failed', handoff: 'fallback', note: null } },
				})
				.where(eq(sessions.id, session.id))
			expect(
				await loadRotationHandoff(db, {
					conversationId: conversation.id,
					agentId,
					threadRootId: null,
				}),
			).toEqual({ note: null })

			await insertSession(db, workspaceId, agentId, humanId, {
				status: 'completed',
				interactive: true,
				conversationId: conversation.id,
			})
			expect(
				await loadRotationHandoff(db, {
					conversationId: conversation.id,
					agentId,
					threadRootId: null,
				}),
			).toBeNull()
		})
	})
})
