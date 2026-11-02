import {
	conversationParticipants,
	messages,
	sessionLogs,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import {
	THREAD_SEED_MAIN_CHAT_MESSAGES,
	_resetSessionDigests,
	loadSiblingSessionsNote,
	loadThreadSeed,
	recordReplyDigest,
	takeSessionDigests,
} from '../../services/chat-session-context'
import { deliverTurnToAgent, evaluateAndRespond } from '../../services/conversation-responder'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// What a thread session knows about the rest of its chat: the seed it starts with, the note on its
// sibling sessions, and the one-line digest of their replies. Real Postgres and a real
// SessionManager; only the container launch is switched off (autoStart false). The old per-chat
// index is dropped for this file's database, the way the bet's index-drop release leaves production.

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

describe('thread session seed, sibling note and digest (Integration)', () => {
	let manager: SessionManager
	let personId: string
	let agentId: string
	let workspaceId: string
	let conversationId: string
	let createSession: ReturnType<typeof vi.spyOn>

	const savedEnv = {
		testers: process.env.FF_TESTER_ACTOR_IDS,
		features: process.env.FF_TESTER_FEATURES,
	}

	function setFlag(on: boolean) {
		process.env.FF_TESTER_ACTOR_IDS = personId
		process.env.FF_TESTER_FEATURES = on ? 'chat-thread-sessions' : ''
		_resetFeatureFlagConfig()
	}

	afterAll(() => {
		for (const [name, value] of [
			['FF_TESTER_ACTOR_IDS', savedEnv.testers],
			['FF_TESTER_FEATURES', savedEnv.features],
		] as const) {
			if (value === undefined) Reflect.deleteProperty(process.env, name)
			else process.env[name] = value
		}
		_resetFeatureFlagConfig()
	})

	beforeEach(async () => {
		_resetSessionDigests()
		personId = getTestActorId()
		workspaceId = (await insertWorkspace(db, personId)).id
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
		const conversation = await insertConversation(db, workspaceId, personId)
		conversationId = conversation.id
		await db.insert(conversationParticipants).values([
			{ conversationId, actorId: personId },
			{ conversationId, actorId: agentId },
		])
		manager = new SessionManager(db, stubStorage())
		const original = manager.createSession.bind(manager)
		createSession = vi
			.spyOn(manager, 'createSession')
			.mockImplementation((ws, params) => original(ws, { ...params, autoStart: false }))
		configureSessionLifecycle({ db, sessionManager: manager })
		setFlag(true)
	})

	afterEach(async () => {
		await manager.stop()
	})

	async function post(actorId: string, content: string, threadRootId?: number) {
		const [row] = await db
			.insert(messages)
			.values({ conversationId, actorId, content, threadRootId: threadRootId ?? null })
			.returning()
		if (!row) throw new Error('failed to insert message')
		return row.id
	}

	const liveChatSession = async (threadRootId: number | null) => {
		const row = await insertSession(db, workspaceId, agentId, personId, {
			status: 'running',
			conversationId,
			interactive: true,
			threadRootId,
		})
		if (!row) throw new Error('failed to insert session')
		return row
	}

	const respond = (messageId: number) =>
		evaluateAndRespond({ db, sessionManager: manager, workspaceId, conversationId, messageId })

	/** The seed prompt of the nth session the responder started. */
	const seedPrompt = (n = 0) => {
		const params = createSession.mock.calls[n]?.[1] as { actionPrompt: string } | undefined
		if (!params) throw new Error('no session was started')
		return params.actionPrompt
	}

	describe('seed', () => {
		it('is the thread root plus the last 20 main-chat messages, never more', async () => {
			const rootId = await post(personId, 'root of the old thread')
			for (let i = 1; i <= 25; i++) await post(personId, `main ${i}`)
			await post(personId, 'a thread reply', rootId)
			const replyId = await post(personId, 'the newest thread reply', rootId)

			const seed = await loadThreadSeed(db, { conversationId, threadRootId: rootId })

			expect(seed.history).toHaveLength(THREAD_SEED_MAIN_CHAT_MESSAGES + 1)
			const texts = seed.history.map((m) => m.content)
			expect(texts[0]).toBe('root of the old thread')
			expect(texts.slice(1)).toEqual(Array.from({ length: 20 }, (_, i) => `main ${i + 6}`))
			expect(texts).not.toContain('main 5')
			expect(texts).not.toContain('a thread reply')

			await respond(replyId)

			const prompt = seedPrompt()
			expect(prompt).toContain('root of the old thread')
			expect(prompt).toContain('main 25')
			expect(prompt).toContain('main 6')
			expect(prompt).not.toContain('main 5')
			// The woken message is in the prompt once, as the new message, not in the history.
			expect(prompt.match(/the newest thread reply/g)).toHaveLength(1)
		})

		it('counts the root once when it is among the last 20', async () => {
			for (let i = 1; i <= 3; i++) await post(personId, `main ${i}`)
			const rootId = await post(personId, 'the root')
			await post(personId, 'main after')

			const seed = await loadThreadSeed(db, { conversationId, threadRootId: rootId })

			expect(seed.history.map((m) => m.content)).toEqual([
				'main 1',
				'main 2',
				'main 3',
				'the root',
				'main after',
			])
		})

		it('cuts a very long message and reports a rough size', async () => {
			const rootId = await post(personId, 'x'.repeat(10_000))

			const seed = await loadThreadSeed(db, { conversationId, threadRootId: rootId })

			expect(seed.history[0]?.content.length).toBeLessThan(2100)
			expect(seed.approxTokens).toBeGreaterThan(0)
			expect(seed.approxTokens).toBeLessThan(700)
		})

		it('does not change the seed of a main-chat session', async () => {
			for (let i = 1; i <= 20; i++) await post(personId, `main ${i}`)
			const id = await post(personId, 'hello agent')

			await respond(id)

			// The responder's own history: the last 15 messages, not the 20-message thread seed.
			const prompt = seedPrompt()
			expect(prompt).toContain('main 7')
			expect(prompt).not.toContain('main 6')
			expect(prompt).not.toContain('Your other live sessions')
		})
	})

	describe('sibling note', () => {
		it('tells a new thread session about the main-chat session', async () => {
			const rootId = await post(personId, 'the root')
			const replyId = await post(personId, 'a reply', rootId)
			await liveChatSession(null)

			await respond(replyId)

			expect(seedPrompt()).toContain('Your other live sessions in this chat')
			expect(seedPrompt()).toContain('the main chat')
		})

		it('names the other threads by their root message', async () => {
			const a = await post(personId, 'budget question')
			const b = await post(personId, 'launch plan')
			await post(personId, 'a reply', b)
			await liveChatSession(a)

			const note = await loadSiblingSessionsNote(db, {
				conversationId,
				agentId,
				threadRootId: b,
			})

			expect(note).toContain('the thread "budget question"')
			expect(note).not.toContain('launch plan')
		})

		it('is left out when the agent has no other live session', async () => {
			const rootId = await post(personId, 'the root')
			const replyId = await post(personId, 'a reply', rootId)

			await respond(replyId)

			expect(seedPrompt()).not.toContain('Your other live sessions')
		})

		it('is left out with the flag off', async () => {
			setFlag(false)
			const rootId = await post(personId, 'the root')
			const replyId = await post(personId, 'a reply', rootId)
			await liveChatSession(null)

			await respond(replyId)

			expect(seedPrompt()).not.toContain('Your other live sessions')
		})
	})

	describe('digest', () => {
		it('goes to the agent’s other live sessions in the chat, not to the one that replied', async () => {
			const rootId = await post(personId, 'budget question')
			const main = await liveChatSession(null)
			const thread = await liveChatSession(rootId)

			await recordReplyDigest(db, {
				conversationId,
				agentId,
				sessionId: thread.id,
				sessionThreadRootId: rootId,
				content: 'The budget is\n 12 000, signed off.',
			})

			const forMain = takeSessionDigests(main.id)
			expect(forMain).toContain('the thread "budget question"')
			expect(forMain).toContain('The budget is 12 000, signed off.')
			expect(takeSessionDigests(thread.id)).toBe('')
			// Taken once: a digest is handed over a single time.
			expect(takeSessionDigests(main.id)).toBe('')
		})

		it('is one line per reply and capped, oldest first out', async () => {
			const rootId = await post(personId, 'the root')
			const main = await liveChatSession(null)
			const thread = await liveChatSession(rootId)

			for (let i = 1; i <= 7; i++) {
				await recordReplyDigest(db, {
					conversationId,
					agentId,
					sessionId: thread.id,
					sessionThreadRootId: rootId,
					content: `reply ${i} ${'y'.repeat(400)}`,
				})
			}

			const digest = takeSessionDigests(main.id)
			const lines = digest.split('\n').filter((l) => l.startsWith('- '))
			expect(lines).toHaveLength(5)
			expect(lines[0]).toContain('reply 3 ')
			expect(lines[4]).toContain('reply 7 ')
			for (const l of lines) expect(l.length).toBeLessThan(220)
		})

		it('is not shared by a session that is not one of the agent’s chat sessions', async () => {
			const main = await liveChatSession(null)
			const helper = await insertSession(db, workspaceId, agentId, personId, {
				status: 'running',
				conversationId: null,
				interactive: true,
			})
			if (!helper) throw new Error('failed to insert session')

			await recordReplyDigest(db, {
				conversationId,
				agentId,
				sessionId: helper.id,
				sessionThreadRootId: null,
				content: 'a helper posted',
			})
			expect(takeSessionDigests(main.id)).toBe('')
		})

		it('never starts a reply: a session that only received a digest posts nothing', async () => {
			const rootId = await post(personId, 'the root')
			const main = await liveChatSession(null)
			const thread = await liveChatSession(rootId)
			const writeInput = vi.spyOn(manager, 'writeInput').mockResolvedValue()
			const messagesBefore = await db
				.select({ id: messages.id })
				.from(messages)
				.where(eq(messages.conversationId, conversationId))
			const logsBefore = await db
				.select({ id: sessionLogs.id })
				.from(sessionLogs)
				.where(eq(sessionLogs.sessionId, main.id))

			await recordReplyDigest(db, {
				conversationId,
				agentId,
				sessionId: thread.id,
				sessionThreadRootId: rootId,
				content: 'the thread session answered',
			})

			// Nothing was written to the receiving session, no session was started, no message posted.
			expect(writeInput).not.toHaveBeenCalled()
			expect(createSession).not.toHaveBeenCalled()
			const messagesAfter = await db
				.select({ id: messages.id })
				.from(messages)
				.where(eq(messages.conversationId, conversationId))
			expect(messagesAfter).toHaveLength(messagesBefore.length)
			const logsAfter = await db
				.select({ id: sessionLogs.id })
				.from(sessionLogs)
				.where(eq(sessionLogs.sessionId, main.id))
			expect(logsAfter).toHaveLength(logsBefore.length)
		})

		it('rides on the receiver’s next turn, marked as context only', async () => {
			const rootId = await post(personId, 'the root')
			const main = await liveChatSession(null)
			const thread = await liveChatSession(rootId)
			const writeInput = vi.spyOn(manager, 'writeInput').mockResolvedValue()
			await recordReplyDigest(db, {
				conversationId,
				agentId,
				sessionId: thread.id,
				sessionThreadRootId: rootId,
				content: 'the thread session answered',
			})
			const messageId = await post(personId, 'a new main chat message')

			await deliverTurnToAgent({
				db,
				sessionManager: manager,
				workspaceId,
				conversationId,
				messageId,
				threadRootId: null,
				agentId,
				message: {
					actorId: personId,
					authorName: 'Person',
					authorType: 'human',
					content: 'a new main chat message',
				},
				conversationHistory: [],
				isDirectConversation: true,
				wakeReason: 'legacy',
			})

			expect(writeInput).toHaveBeenCalledTimes(1)
			const [sessionId, payload] = writeInput.mock.calls[0] as [
				string,
				{ message: { content: string } },
			]
			expect(sessionId).toBe(main.id)
			expect(payload.message.content).toContain('a new main chat message')
			expect(payload.message.content).toContain('do not answer this part')
			expect(payload.message.content).toContain('the thread session answered')
			expect(takeSessionDigests(main.id)).toBe('')
		})
	})
})
