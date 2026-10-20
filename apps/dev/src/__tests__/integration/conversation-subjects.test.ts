import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, conversations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
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
})
