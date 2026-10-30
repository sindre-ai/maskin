import {
	conversationParticipants,
	messages,
	sessions,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { deliverTurnToAgent, evaluateAndRespond } from '../../services/conversation-responder'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// One session per (chat, agent, thread), behind the chat-thread-sessions flag. Real Postgres and
// a real SessionManager; only the container launch is switched off (autoStart false), so a
// session stays pending and counts as live. The old per-chat index is dropped for this file's
// database, the way the bet's index-drop release leaves production.

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

describe('thread sessions behind the flag (Integration)', () => {
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

	beforeAll(async () => {
		await sql`DROP INDEX IF EXISTS sessions_conversation_actor_active_uniq`
	})

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
		// Real createSession (it writes the thread column) without launching a container.
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

	/** A top-level message and a person's reply under it; returns both ids. */
	async function startThread(label: string) {
		const rootId = await post(personId, `${label} root`)
		const replyId = await post(personId, `${label} reply`, rootId)
		return { rootId, replyId }
	}

	const respond = (messageId: number) =>
		evaluateAndRespond({ db, sessionManager: manager, workspaceId, conversationId, messageId })

	const liveSessions = () =>
		db
			.select({ id: sessions.id, threadRootId: sessions.threadRootId, status: sessions.status })
			.from(sessions)
			.where(eq(sessions.conversationId, conversationId))

	const spawnedThreads = () =>
		createSession.mock.calls.map(
			([, params]) =>
				(params.config?.conversation as { thread_root_id?: number } | undefined)?.thread_root_id ??
				null,
		)

	it('starts a session of its own for a thread message when the flag is on', async () => {
		const { rootId, replyId } = await startThread('a')

		await respond(replyId)

		expect(spawnedThreads()).toEqual([rootId])
		const rows = await liveSessions()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.threadRootId).toBe(rootId)
	})

	it('reuses the live session of that thread for the next message in it', async () => {
		const { rootId, replyId } = await startThread('a')
		await respond(replyId)
		const second = await post(personId, 'a second reply', rootId)

		await respond(second)

		expect(createSession).toHaveBeenCalledTimes(1)
		expect(await liveSessions()).toHaveLength(1)
	})

	it('keeps a main-chat message on the main session next to a live thread session', async () => {
		const { rootId, replyId } = await startThread('a')
		await respond(replyId)

		await respond(await post(personId, 'a main chat message'))

		const rows = await liveSessions()
		expect(rows.map((r) => r.threadRootId).sort()).toEqual([null, rootId])
	})

	it('gives a second thread its own session', async () => {
		const a = await startThread('a')
		const b = await startThread('b')

		await respond(a.replyId)
		await respond(b.replyId)

		expect(spawnedThreads()).toEqual([a.rootId, b.rootId])
	})

	it('sends a fourth thread to the main session, at most 3 thread sessions per agent', async () => {
		const threads = [
			await startThread('a'),
			await startThread('b'),
			await startThread('c'),
			await startThread('d'),
		]
		for (const t of threads.slice(0, 3)) await respond(t.replyId)

		await respond((threads[3] as (typeof threads)[number]).replyId)

		const rows = await liveSessions()
		expect(rows.filter((r) => r.threadRootId !== null)).toHaveLength(3)
		expect(rows.filter((r) => r.threadRootId === null)).toHaveLength(1)
		expect(spawnedThreads()[3]).toBeNull()
	})

	it('uses the single-session path, without queueing, when the workspace has no chat capacity', async () => {
		await db
			.update(workspaces)
			.set({ settings: { max_concurrent_chat_sessions: 1 } })
			.where(eq(workspaces.id, workspaceId))
		// One running chat session already fills the cap.
		const other = await insertConversation(db, workspaceId, personId)
		await insertSession(db, workspaceId, agentId, personId, {
			status: 'running',
			conversationId: other.id,
			interactive: true,
		})
		const { replyId } = await startThread('a')

		await respond(replyId)

		expect(spawnedThreads()).toEqual([null])
		const rows = await liveSessions()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.threadRootId).toBeNull()
		expect(rows[0]?.status).not.toBe('queued')
	})

	it('runs the single-session path when the flag is off for the sender', async () => {
		setFlag(false)
		const { replyId } = await startThread('a')

		await respond(replyId)

		expect(spawnedThreads()).toEqual([null])
		const rows = await liveSessions()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.threadRootId).toBeNull()
	})

	it('reads the flag for the person who wrote the message, never the agent', async () => {
		const { rootId, replyId } = await startThread('a')

		await deliverTurnToAgent({
			db,
			sessionManager: manager,
			workspaceId,
			conversationId,
			messageId: replyId,
			threadRootId: rootId,
			agentId,
			message: {
				actorId: agentId,
				authorName: 'Another agent',
				authorType: 'agent',
				content: 'an agent writing in the thread',
			},
			conversationHistory: [],
			isDirectConversation: false,
			wakeReason: 'legacy',
		})

		expect(spawnedThreads()).toEqual([null])
	})

	it('rejects a second live session for the same chat, agent and thread, and for the main chat', async () => {
		const { rootId } = await startThread('a')
		const live = {
			status: 'running',
			conversationId,
			interactive: true,
		}
		await insertSession(db, workspaceId, agentId, personId, { ...live, threadRootId: rootId })
		await insertSession(db, workspaceId, agentId, personId, { ...live, threadRootId: null })

		await expect(
			insertSession(db, workspaceId, agentId, personId, { ...live, threadRootId: rootId }),
		).rejects.toMatchObject({ cause: { code: '23505' } })
		await expect(
			insertSession(db, workspaceId, agentId, personId, { ...live, threadRootId: null }),
		).rejects.toMatchObject({ cause: { code: '23505' } })
	})
})
