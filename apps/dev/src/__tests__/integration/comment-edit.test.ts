import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { postComment } from '../../lib/comments'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: eventsRoutes } = await import('../../routes/events')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: unknown
	}
}

const createSession = vi.fn()

function createEventsApp() {
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
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', { createSession })
		await next()
	})
	app.route('/api/events', eventsRoutes)
	return app
}

function patchComment(
	app: ReturnType<typeof createEventsApp>,
	workspaceId: string,
	id: number,
	body: unknown,
) {
	return app.request(
		jsonRequest('PATCH', `/api/events/${id}`, body, { 'x-workspace-id': workspaceId }),
	)
}

type CommentData = {
	content?: string
	mentions?: string[]
	editedAt?: string
	decision?: unknown
}

describe('Events Integration — edit your own comment', () => {
	let workspaceId: string
	let objectId: string
	let actorId: string

	beforeEach(async () => {
		createSession.mockClear()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const obj = await insertObject(db, workspaceId, actorId)
		objectId = obj.id
	})

	async function seedComment(
		authorId: string,
		extra?: { mentions?: string[]; decision?: Parameters<typeof postComment>[1]['decision'] },
	) {
		const { comment } = await postComment(db, {
			workspaceId,
			actorId: authorId,
			entityId: objectId,
			entityType: 'object',
			content: 'first draft',
			...extra,
		})
		return Number(comment.id)
	}

	it('saves the new text and the edit time', async () => {
		const id = await seedComment(actorId)
		const res = await patchComment(createEventsApp(), workspaceId, id, { content: 'second draft' })
		expect(res.status).toBe(200)
		const json = (await res.json()) as { id: number; data: CommentData }
		expect(json.id).toBe(id)
		expect(json.data.content).toBe('second draft')
		expect(typeof json.data.editedAt).toBe('string')

		const [row] = await db.select().from(events).where(eq(events.id, id))
		expect((row?.data as CommentData).content).toBe('second draft')
		expect((row?.data as CommentData).editedAt).toBe(json.data.editedAt)
	})

	it('keeps who was mentioned and wakes nobody', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Edit Test Agent' })
		const id = await seedComment(actorId, { mentions: [agent.id] })
		const commentsBefore = await db
			.select({ id: events.id })
			.from(events)
			.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))

		const res = await patchComment(createEventsApp(), workspaceId, id, {
			content: 'second draft, now with more words',
			mentions: [actorId],
		})
		expect(res.status).toBe(200)

		const [row] = await db.select().from(events).where(eq(events.id, id))
		expect((row?.data as CommentData).mentions).toEqual([agent.id])
		const commentsAfter = await db
			.select({ id: events.id })
			.from(events)
			.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
		expect(commentsAfter).toHaveLength(commentsBefore.length)
		expect(createSession).not.toHaveBeenCalled()
	})

	it('refuses an edit from someone who did not write the comment', async () => {
		const other = await insertActor(db, { type: 'human', name: 'Someone Else' })
		const id = await seedComment(other.id)
		const res = await patchComment(createEventsApp(), workspaceId, id, { content: 'hijack' })
		expect(res.status).toBe(403)

		const [row] = await db.select().from(events).where(eq(events.id, id))
		expect((row?.data as CommentData).content).toBe('first draft')
		expect((row?.data as CommentData).editedAt).toBeUndefined()
	})

	it('returns 404 for a comment in another workspace', async () => {
		const id = await seedComment(actorId)
		const otherWs = await insertWorkspace(db, actorId)
		const res = await patchComment(createEventsApp(), otherWs.id, id, { content: 'nope' })
		expect(res.status).toBe(404)
	})

	it('returns 404 for an event that is not a comment', async () => {
		await seedComment(actorId)
		const [other] = await db
			.select({ id: events.id })
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.action, 'created')))
			.limit(1)
		if (!other) return
		const res = await patchComment(createEventsApp(), workspaceId, other.id, { content: 'nope' })
		expect(res.status).toBe(404)
	})

	it('rejects empty text', async () => {
		const id = await seedComment(actorId)
		const res = await patchComment(createEventsApp(), workspaceId, id, { content: '' })
		expect(res.status).toBe(400)
	})

	it('does not edit a decision card', async () => {
		const id = await seedComment(actorId, {
			decision: {
				title: 'Ship it?',
				summary: 'Ready.',
				options: [
					{ label: 'Ship', recommended: true, consequences: ['Goes live', 'No rollback'] },
					{ label: 'Hold', consequences: ['Waits a day', 'Costs nothing'] },
				],
			},
		})
		const res = await patchComment(createEventsApp(), workspaceId, id, { content: 'changed' })
		expect(res.status).toBe(400)
	})
})
