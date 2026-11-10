import {
	conversationParticipants,
	messages,
	sessions,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { deliverTurnToAgent, evaluateAndRespond } from '../../services/conversation-responder'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// One session per (chat, agent, thread). Real Postgres and
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

describe('thread sessions (Integration)', () => {
	let manager: SessionManager
	let personId: string
	let agentId: string
	let workspaceId: string
	let conversationId: string
	let createSession: ReturnType<typeof vi.spyOn>

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

	it('starts a session of its own for a thread message', async () => {
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
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => r.threadRootId)).toEqual(expect.arrayContaining([null, rootId]))
	})

	it('gives a second thread its own session', async () => {
		const a = await startThread('a')
		const b = await startThread('b')

		await respond(a.replyId)
		await respond(b.replyId)

		expect(spawnedThreads()).toEqual([a.rootId, b.rootId])
	})

	it('gives every thread its own session, with no limit per agent', async () => {
		const threads = []
		for (const label of ['a', 'b', 'c', 'd', 'e']) threads.push(await startThread(label))
		for (const t of threads) await respond(t.replyId)

		const rows = await liveSessions()
		expect(rows.filter((r) => r.threadRootId !== null)).toHaveLength(5)
		expect(spawnedThreads()).toEqual(threads.map((t) => t.rootId))
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

	it('keeps a thread message written by an agent on the main session', async () => {
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
