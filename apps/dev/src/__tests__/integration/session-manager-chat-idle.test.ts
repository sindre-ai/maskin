import {
	events,
	agentServers,
	conversationPendingTurns,
	conversations,
	messages,
	sessionLogs,
	sessions,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { asc, eq } from 'drizzle-orm'
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

async function insertAgentServer() {
	const [row] = await db
		.insert(agentServers)
		.values({
			url: 'https://chat-idle-under-test.maskin.test:3001',
			secret: 'x'.repeat(32),
			maxConcurrentSessions: 10,
			status: 'active',
		})
		.returning()
	if (!row) throw new Error('failed to insert agent server')
	return row
}

async function insertConversation(workspaceId: string, createdBy: string) {
	const [row] = await db
		.insert(conversations)
		.values({ workspaceId, title: 'Chat idle test', createdBy })
		.returning()
	if (!row) throw new Error('failed to insert conversation')
	return row
}

describe('SessionManager conversation-turn drain + idle chat close (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		await sql`TRUNCATE agent_servers CASCADE`
	})

	describe('drainPendingConversationTurns()', () => {
		it('delivers buffered turns in message order over the remote input endpoint and clears them', async () => {
			const server = await insertAgentServer()
			const conversation = await insertConversation(workspaceId, actorId)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				interactive: true,
				conversationId: conversation.id,
				agentServerId: server.id,
				containerId: 'sandbox-drain-test',
			})
			// Two buffered turns, inserted out of message order to prove ordering
			// comes from messageId, not insertion order. The messageId FK is
			// enforced, so create real message rows.
			const [m1] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId, content: 'first' })
				.returning()
			const [m2] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId, content: 'second' })
				.returning()
			if (!m1 || !m2) throw new Error('failed to insert messages')
			await db.insert(conversationPendingTurns).values({
				conversationId: conversation.id,
				actorId,
				messageId: m2.id,
				payload: { type: 'user', message: { role: 'user', content: 'turn two' } },
			})
			await db.insert(conversationPendingTurns).values({
				conversationId: conversation.id,
				actorId,
				messageId: m1.id,
				payload: { type: 'user', message: { role: 'user', content: 'turn one' } },
			})

			const inputCalls: Array<{ url: string; body: string }> = []
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
				inputCalls.push({ url: String(input), body: String(init?.body ?? '') })
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.drainPendingConversationTurns(session.id)
			} finally {
				fetchSpy.mockRestore()
				await manager.stop()
			}

			expect(inputCalls).toHaveLength(2)
			expect(inputCalls[0]?.url).toBe(`${server.url}/sessions/${session.id}/input`)
			expect(inputCalls[0]?.body).toContain('turn one')
			expect(inputCalls[1]?.body).toContain('turn two')

			// Claimed rows are gone — a second drain delivers nothing.
			const remaining = await db
				.select()
				.from(conversationPendingTurns)
				.where(eq(conversationPendingTurns.conversationId, conversation.id))
			expect(remaining).toHaveLength(0)

			// Each delivered turn is persisted to session_logs tagged with its
			// message id, so the chat UI can anchor the turn to its message.
			const logRows = await db
				.select()
				.from(sessionLogs)
				.where(eq(sessionLogs.sessionId, session.id))
				.orderBy(asc(sessionLogs.id))
			const tagged = logRows.filter((r) => r.content.includes('maskin_message_id'))
			expect(tagged).toHaveLength(2)
			expect(JSON.parse(tagged[0]?.content ?? '{}').maskin_message_id).toBe(m1.id)
			expect(JSON.parse(tagged[1]?.content ?? '{}').maskin_message_id).toBe(m2.id)
		})

		it('no-ops for a non-conversation session', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				interactive: false,
			})
			const fetchSpy = vi.spyOn(globalThis, 'fetch')
			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.drainPendingConversationTurns(session.id)
			} finally {
				fetchSpy.mockRestore()
				await manager.stop()
			}
			expect(fetchSpy).not.toHaveBeenCalled()
		})
	})

	describe('watchdog idle chat close', () => {
		it('completes a conversation session idle past the threshold and stops the remote sandbox', async () => {
			const server = await insertAgentServer()
			const conversation = await insertConversation(workspaceId, actorId)
			const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				interactive: true,
				conversationId: conversation.id,
				agentServerId: server.id,
				containerId: 'sandbox-idle-test',
				startedAt: fortyMinAgo,
				timeoutAt: null,
			})
			await insertSessionLog(db, session.id, {
				content: 'last activity',
				createdAt: new Date(Date.now() - 35 * 60 * 1000),
			})

			const stopCalls: string[] = []
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
				stopCalls.push(String(input))
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
			} finally {
				fetchSpy.mockRestore()
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect((row?.result as { summary?: string })?.summary).toContain('idle')
			expect(row?.completedAt).not.toBeNull()

			expect(stopCalls).toContain(`${server.url}/sessions/${session.id}/stop`)

			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			const completed = eventRows.find((e) => e.action === 'session_completed')
			expect(completed).toBeTruthy()
			expect((completed?.data as { reason?: string })?.reason).toBe('idle_conversation')

			// SSE /logs/stream matches this prefix to emit its `done` event.
			const logRows = await db
				.select()
				.from(sessionLogs)
				.where(eq(sessionLogs.sessionId, session.id))
			expect(logRows.some((r) => r.content.startsWith('Session completed'))).toBe(true)
		})

		it('leaves a recently-active conversation session running', async () => {
			const server = await insertAgentServer()
			const conversation = await insertConversation(workspaceId, actorId)
			const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				interactive: true,
				conversationId: conversation.id,
				agentServerId: server.id,
				containerId: 'sandbox-active-test',
				startedAt: fortyMinAgo,
				timeoutAt: null,
			})
			// Active five minutes ago — well inside the idle threshold.
			await insertSessionLog(db, session.id, {
				content: 'recent activity',
				createdAt: new Date(Date.now() - 5 * 60 * 1000),
			})

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			})
			const manager = new SessionManager(db, stubStorage())
			try {
				await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
			} finally {
				fetchSpy.mockRestore()
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('running')
		})

		it('closes an interactive conversation session hitting the hard timeout as completed, not timeout', async () => {
			const conversation = await insertConversation(workspaceId, actorId)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				interactive: true,
				conversationId: conversation.id,
				containerId: null,
				startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
				// Hard timeout already passed — the reaper (not the idle close)
				// must pick it up. Recent log keeps the idle close out of the way.
				timeoutAt: new Date(Date.now() - 60 * 1000),
			})
			await insertSessionLog(db, session.id, {
				content: 'still chatting',
				createdAt: new Date(Date.now() - 2 * 60 * 1000),
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect((row?.result as { summary?: string })?.summary).toBeTruthy()
			expect((row?.result as { error?: string })?.error).toBeUndefined()

			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows.some((e) => e.action === 'session_completed')).toBe(true)
			expect(eventRows.some((e) => e.action === 'session_timeout')).toBe(false)
		})

		it('still marks a non-conversation session hitting the hard timeout as timeout', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				interactive: false,
				containerId: null,
				startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
				timeoutAt: new Date(Date.now() - 60 * 1000),
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('timeout')
			expect((row?.result as { error?: string })?.error).toBe('Session timed out')
		})
	})
})
