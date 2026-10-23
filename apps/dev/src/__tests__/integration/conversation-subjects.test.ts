import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversationParticipants,
	conversations,
	messages,
	subscriptions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { postComment } from '../../lib/comments'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertObject, insertWorkspace } from '../factories'
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

describe('Conversation subjects', () => {
	let ownerId: string
	let otherId: string
	let workspaceId: string
	let objectId: string
	const ws = () => ({ 'x-workspace-id': workspaceId })
	const open = (actor: string, body: Record<string, unknown>) =>
		appFor(actor).request(jsonRequest('POST', '/api/conversations', body, ws()))

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		otherId = (await insertActor(db, { type: 'human' })).id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: otherId, role: 'member' })
		objectId = (await insertObject(db, workspaceId, ownerId)).id
	})

	it('creates a chat tied to an object and finds it again by subject', async () => {
		const res = await open(ownerId, {
			title: 'Tom',
			participant_actor_ids: [otherId],
			subject: { type: 'object', id: objectId },
		})
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string; subjectType: string; subjectId: string }
		expect([created.subjectType, created.subjectId]).toEqual(['object', objectId])

		const list = await appFor(ownerId).request(
			jsonGet(`/api/conversations?subject_type=object&subject_id=${objectId}`, ws()),
		)
		const { conversations: found } = (await list.json()) as { conversations: { id: string }[] }
		expect(found.map((c) => c.id)).toEqual([created.id])
	})

	it('returns the same chat when the subject is opened again, and adds the newcomer', async () => {
		const first = await open(ownerId, {
			title: 'Tom',
			participant_actor_ids: [],
			subject: { type: 'object', id: objectId },
		})
		const { id } = (await first.json()) as { id: string }

		const again = await open(otherId, {
			title: 'Tom (again)',
			participant_actor_ids: [],
			subject: { type: 'object', id: objectId },
		})
		expect(again.status).toBe(200)
		expect(((await again.json()) as { id: string }).id).toBe(id)

		const all = await db
			.select()
			.from(conversations)
			.where(eq(conversations.workspaceId, workspaceId))
		expect(all).toHaveLength(1)
		const [member] = await db
			.select()
			.from(conversationParticipants)
			.where(
				and(
					eq(conversationParticipants.conversationId, id),
					eq(conversationParticipants.actorId, otherId),
				),
			)
		expect(member?.leftAt).toBeNull()
	})

	it('rejects a subject that is not in this workspace', async () => {
		const res = await open(ownerId, {
			title: 'Ghost',
			participant_actor_ids: [],
			subject: { type: 'object', id: crypto.randomUUID() },
		})
		expect(res.status).toBe(400)
	})

	it('the database allows only one chat per subject', async () => {
		await open(ownerId, {
			title: 'Tom',
			participant_actor_ids: [],
			subject: { type: 'object', id: objectId },
		})
		await expect(
			db.insert(conversations).values({
				workspaceId,
				title: 'Dupe',
				createdBy: ownerId,
				subjectType: 'object',
				subjectId: objectId,
			}),
		).rejects.toThrow()
	})

	it('leaves ordinary chats without a subject', async () => {
		const res = await open(ownerId, { title: 'Plain', participant_actor_ids: [otherId] })
		const body = (await res.json()) as { subjectType: string | null; subjectId: string | null }
		expect([body.subjectType, body.subjectId]).toEqual([null, null])
	})

	describe('object chats and comments', () => {
		const commentsOn = (entityId: string) =>
			db
				.select()
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.entityId, entityId),
						eq(events.action, 'commented'),
					),
				)

		it('turns a message in an object chat into a comment on the object', async () => {
			const created = await open(ownerId, {
				title: 'Tom',
				participant_actor_ids: [otherId],
				subject: { type: 'object', id: objectId },
			})
			const { id } = (await created.json()) as { id: string }
			const res = await appFor(ownerId).request(
				jsonRequest(
					'POST',
					`/api/conversations/${id}/messages`,
					{ content: 'Ready for review', metadata: { mentions: [otherId] } },
					ws(),
				),
			)
			expect(res.status).toBe(201)

			const [comment] = await commentsOn(objectId)
			const data = comment?.data as {
				content: string
				mentions: string[]
				metadata: { suppress_auto_dispatch: boolean; via_chat: { conversation_id: string } }
			}
			expect(data.content).toBe('Ready for review')
			expect(data.mentions).toEqual([otherId])
			// The chat wakes agents itself; the comment dispatcher must stay out.
			expect(data.metadata.suppress_auto_dispatch).toBe(true)
			expect(data.metadata.via_chat.conversation_id).toBe(id)

			const subs = await db
				.select()
				.from(subscriptions)
				.where(and(eq(subscriptions.entityId, objectId), eq(subscriptions.actorId, otherId)))
			expect(subs.map((r) => r.source)).toEqual(['mentioned'])
		})

		it('also mirrors the first message of a new object chat', async () => {
			await open(ownerId, {
				title: 'Tom',
				participant_actor_ids: [],
				initial_message: 'Kicking this off',
				subject: { type: 'object', id: objectId },
			})
			const comments = await commentsOn(objectId)
			expect(comments.map((c) => (c.data as { content: string }).content)).toEqual([
				'Kicking this off',
			])
		})

		it('does not comment on anything for an ordinary chat', async () => {
			const created = await open(ownerId, { title: 'Plain', participant_actor_ids: [otherId] })
			const { id } = (await created.json()) as { id: string }
			await appFor(ownerId).request(
				jsonRequest('POST', `/api/conversations/${id}/messages`, { content: 'hello' }, ws()),
			)
			expect(await commentsOn(objectId)).toHaveLength(0)
		})
	})

	describe('comments already on the object', () => {
		const chatMessages = async (conversationId: string) =>
			db
				.select()
				.from(messages)
				.where(eq(messages.conversationId, conversationId))
				.orderBy(messages.id)

		it('opens a new chat with the old comments as history, with replies as thread replies', async () => {
			const first = await postComment(db, {
				workspaceId,
				actorId: otherId,
				entityId: objectId,
				content: 'Looks good to me',
			})
			await postComment(db, {
				workspaceId,
				actorId: ownerId,
				entityId: objectId,
				content: 'Thanks',
				parentEventId: first.comment.id,
			})

			const res = await open(ownerId, {
				title: 'Tom',
				participant_actor_ids: [],
				subject: { type: 'object', id: objectId },
			})
			const { id } = (await res.json()) as { id: string }
			const rows = await chatMessages(id)

			expect(rows.map((m) => m.content)).toEqual(['Looks good to me', 'Thanks'])
			expect(rows[0]?.actorId).toBe(otherId)
			expect(rows[1]?.threadRootId).toBe(rows[0]?.id)
			// The people who commented are in the chat, and the history is read.
			const [theirs] = await db
				.select()
				.from(conversationParticipants)
				.where(
					and(
						eq(conversationParticipants.conversationId, id),
						eq(conversationParticipants.actorId, otherId),
					),
				)
			expect(theirs?.lastReadMessageId).toBe(rows[1]?.id)
			// Nothing was echoed back as a second comment.
			const comments = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
			expect(comments).toHaveLength(2)
		})

		it('shows a comment posted later in the chat, once, and does not echo chat messages back', async () => {
			const res = await open(ownerId, {
				title: 'Tom',
				participant_actor_ids: [],
				subject: { type: 'object', id: objectId },
			})
			const { id } = (await res.json()) as { id: string }

			await postComment(db, {
				workspaceId,
				actorId: otherId,
				entityId: objectId,
				content: 'From the old comment box',
			})
			await appFor(ownerId).request(
				jsonRequest(
					'POST',
					`/api/conversations/${id}/messages`,
					{ content: 'From the chat' },
					ws(),
				),
			)

			expect((await chatMessages(id)).map((m) => m.content)).toEqual([
				'From the old comment box',
				'From the chat',
			])
			const comments = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
			expect(comments).toHaveLength(2)
		})

		it('does not copy the same comment into the chat twice', async () => {
			const res = await open(ownerId, {
				title: 'Tom',
				participant_actor_ids: [],
				subject: { type: 'object', id: objectId },
			})
			const { id } = (await res.json()) as { id: string }
			const { comment } = await postComment(db, {
				workspaceId,
				actorId: otherId,
				entityId: objectId,
				content: 'Once',
			})
			const { mirrorCommentIntoChat } = await import('../../services/object-chat-sync')
			await mirrorCommentIntoChat(db, {
				id: comment.id,
				actorId: comment.actorId,
				createdAt: comment.createdAt,
				data: comment.data,
				workspaceId,
				entityId: objectId,
			})
			expect(await chatMessages(id)).toHaveLength(1)
		})
	})
})
