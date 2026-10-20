import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	messageThreadReads,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function appFor(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

type Msg = {
	id: number
	threadRootId: number | null
	threadAlsoInChannel: boolean
	thread?: {
		replyCount: number
		unreadCount: number
		lastReplyId: number
		participants: { actorId: string }[]
	} | null
}

describe('Message threads', () => {
	let ownerId: string
	let otherId: string
	let workspaceId: string
	let conversationId: string
	let rootId: number
	const ws = () => ({ 'x-workspace-id': workspaceId })

	async function post(actor: string, body: Record<string, unknown>) {
		return appFor(actor).request(
			jsonRequest('POST', `/api/conversations/${conversationId}/messages`, body, ws()),
		)
	}

	beforeEach(async () => {
		ownerId = getTestActorId()
		const w = await insertWorkspace(db, ownerId)
		workspaceId = w.id
		const other = await insertActor(db, { type: 'human' })
		otherId = other.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: otherId, role: 'member' })
		const created = await appFor(ownerId).request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Pipeline', participant_actor_ids: [otherId], initial_message: 'dry run done' },
				ws(),
			),
		)
		conversationId = ((await created.json()) as { id: string }).id
		const [root] = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
		rootId = root?.id as number
	})

	it('stores a reply under its root and shows the summary on the root', async () => {
		const res = await post(otherId, { content: 'keep Qualifier', thread_root_id: rootId })
		expect(res.status).toBe(201)
		const reply = (await res.json()) as Msg
		expect(reply.threadRootId).toBe(rootId)
		expect(reply.threadAlsoInChannel).toBe(false)

		const list = await appFor(ownerId).request(
			jsonGet(`/api/conversations/${conversationId}/messages`, ws()),
		)
		const { messages: page } = (await list.json()) as { messages: Msg[] }
		const root = page.find((m) => m.id === rootId)
		expect(root?.thread?.replyCount).toBe(1)
		expect(root?.thread?.unreadCount).toBe(1)
		expect(root?.thread?.participants.map((p) => p.actorId)).toEqual([ownerId, otherId])
	})

	it('returns only the thread replies when thread_root_id is given', async () => {
		await post(otherId, { content: 'in thread', thread_root_id: rootId })
		await post(otherId, { content: 'top level' })
		const res = await appFor(ownerId).request(
			jsonGet(`/api/conversations/${conversationId}/messages?thread_root_id=${rootId}`, ws()),
		)
		const { messages: page } = (await res.json()) as { messages: Msg[] }
		expect(page).toHaveLength(1)
		expect(page[0]?.threadRootId).toBe(rootId)
	})

	it('records also_in_channel only on a thread reply', async () => {
		const withFlag = (await (
			await post(otherId, { content: 'both', thread_root_id: rootId, also_in_channel: true })
		).json()) as Msg
		expect(withFlag.threadAlsoInChannel).toBe(true)
		const topLevel = (await (
			await post(otherId, { content: 'plain', also_in_channel: true })
		).json()) as Msg
		expect(topLevel.threadAlsoInChannel).toBe(false)
	})

	it('rejects a reply to a reply, a foreign root and a missing root', async () => {
		const reply = (await (
			await post(otherId, { content: 'r1', thread_root_id: rootId })
		).json()) as Msg
		expect((await post(otherId, { content: 'nested', thread_root_id: reply.id })).status).toBe(404)
		expect((await post(otherId, { content: 'ghost', thread_root_id: 999999999 })).status).toBe(404)
	})

	it('lists threads the caller is in with unread counts, and advances the cursor only forward', async () => {
		const reply = (await (
			await post(otherId, { content: 'ping', thread_root_id: rootId })
		).json()) as Msg

		const list = await appFor(ownerId).request(jsonGet('/api/conversations/threads', ws()))
		const { threads } = (await list.json()) as {
			threads: { conversationTitle: string; root: Msg; thread: { unreadCount: number } }[]
		}
		expect(threads).toHaveLength(1)
		expect(threads[0]?.conversationTitle).toBe('Pipeline')
		expect(threads[0]?.thread.unreadCount).toBe(1)

		const read = (id: number) =>
			appFor(ownerId).request(
				jsonRequest(
					'PUT',
					`/api/conversations/${conversationId}/messages/${rootId}/thread/read`,
					{ last_read_message_id: id },
					ws(),
				),
			)
		expect(
			((await (await read(reply.id)).json()) as { last_read_message_id: number })
				.last_read_message_id,
		).toBe(reply.id)
		// A lower id must not move the cursor back.
		expect(
			((await (await read(1)).json()) as { last_read_message_id: number }).last_read_message_id,
		).toBe(reply.id)
		const [cursor] = await db
			.select()
			.from(messageThreadReads)
			.where(eq(messageThreadReads.rootMessageId, rootId))
		expect(cursor?.lastReadMessageId).toBe(reply.id)

		const after = await appFor(ownerId).request(jsonGet('/api/conversations/threads', ws()))
		const again = (await after.json()) as { threads: { thread: { unreadCount: number } }[] }
		expect(again.threads[0]?.thread.unreadCount).toBe(0)
	})

	it('omits threads the caller neither started nor replied in', async () => {
		const bystander = await insertActor(db, { type: 'human' })
		await db.insert(conversationParticipants).values({ conversationId, actorId: bystander.id })
		await post(otherId, { content: 'between us', thread_root_id: rootId })
		// The owner wrote the root so sees it; the bystander wrote neither.
		const res = await appFor(bystander.id).request(jsonGet('/api/conversations/threads', ws()))
		expect(((await res.json()) as { threads: unknown[] }).threads).toHaveLength(0)
	})

	it('cascades thread replies and cursors when the root is deleted', async () => {
		await post(otherId, { content: 'gone soon', thread_root_id: rootId })
		await db.delete(messages).where(eq(messages.id, rootId))
		const left = await db.select().from(messages).where(eq(messages.conversationId, conversationId))
		expect(left).toHaveLength(0)
	})
})
