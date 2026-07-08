import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertObject, insertWorkspace } from '../factories'
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

	const sessionManager = { createSession: vi.fn() }

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', sessionManager)
		await next()
	})

	app.route('/api/events', eventsRoutes)
	return app
}

async function postComment(
	app: ReturnType<typeof createEventsApp>,
	workspaceId: string,
	body: { entity_id: string; content: string; parent_event_id?: number },
) {
	const res = await app.request(
		jsonRequest('POST', '/api/events', body, { 'x-workspace-id': workspaceId }),
	)
	expect(res.status).toBe(201)
	return (await res.json()) as { id: number; data: { parentEventId?: number | null } }
}

describe('Events Integration — reply chain collapse', () => {
	let workspaceId: string
	let objectId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const obj = await insertObject(db, workspaceId, getTestActorId())
		objectId = obj.id
	})

	it('keeps parent_event_id when replying to a top-level comment', async () => {
		const app = createEventsApp()
		const root = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'Original verdict',
		})

		const reply = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'first reply',
			parent_event_id: root.id,
		})

		expect(reply.data.parentEventId).toBe(root.id)
	})

	it('collapses a reply-to-reply to the thread root', async () => {
		const app = createEventsApp()
		const root = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'Original verdict',
		})
		const reply = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'can you summarize?',
			parent_event_id: root.id,
		})

		const grandchild = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'summary reply',
			parent_event_id: reply.id,
		})

		expect(grandchild.data.parentEventId).toBe(root.id)
	})

	it('drops parent_event_id when the referenced parent does not exist', async () => {
		const app = createEventsApp()
		const orphan = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'orphan reply',
			parent_event_id: 99_999_999,
		})

		expect(orphan.data.parentEventId ?? null).toBeNull()
	})

	it('drops parent_event_id when the parent comment is on a different object', async () => {
		const app = createEventsApp()
		const otherObject = await insertObject(db, workspaceId, getTestActorId())
		const otherRoot = await postComment(app, workspaceId, {
			entity_id: otherObject.id,
			content: 'comment on a sibling object',
		})

		const stray = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'attempted cross-object reply',
			parent_event_id: otherRoot.id,
		})

		expect(stray.data.parentEventId ?? null).toBeNull()
	})

	it('drops parent_event_id when the referenced event is not a comment', async () => {
		const app = createEventsApp()
		const [nonCommentEvent] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId: getTestActorId(),
				action: 'created',
				entityType: 'object',
				entityId: objectId,
				data: {},
			})
			.returning()

		const reply = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'reply to a non-comment event',
			parent_event_id: nonCommentEvent.id,
		})

		expect(reply.data.parentEventId ?? null).toBeNull()
	})

	it('round-trips metadata.tasks and a ```chart fenced block through the events row', async () => {
		const app = createEventsApp()
		const taskId = '11111111-1111-4111-8111-111111111111'
		const chartFence = [
			'```chart',
			'{"type":"bar","x":"day","series":["v"],"data":[]}',
			'```',
		].join('\n')
		const content = `Week-1 retention\n\n${chartFence}`
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/events',
				{
					entity_id: objectId,
					content,
					metadata: { tasks: [taskId] },
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)
		const posted = (await res.json()) as { id: number }

		const [stored] = await db.select().from(events).where(eq(events.id, posted.id)).limit(1)
		const data = stored.data as {
			content: string
			metadata?: { tasks?: unknown }
		}
		expect(data.content).toContain('```chart')
		expect(Array.isArray(data.metadata?.tasks)).toBe(true)
		expect(data.metadata?.tasks).toEqual([taskId])
	})

	it('rejects metadata values whose shape escapes safeMetadataSchema', async () => {
		const app = createEventsApp()
		// safeMetadataSchema only allows arrays of primitives; nested objects are
		// not part of the contract and must be refused at the boundary so the
		// renderer can trust the shape it reads back.
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/events',
				{
					entity_id: objectId,
					content: 'bad metadata',
					metadata: { tasks: [{ id: 'not-a-uuid-just-an-object' }] },
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(400)
	})

	it('persists the rewritten parentEventId in the events row', async () => {
		const app = createEventsApp()
		const root = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'root',
		})
		const reply = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'depth-1',
			parent_event_id: root.id,
		})
		const grandchild = await postComment(app, workspaceId, {
			entity_id: objectId,
			content: 'depth-2',
			parent_event_id: reply.id,
		})

		const [stored] = await db.select().from(events).where(eq(events.id, grandchild.id)).limit(1)

		const data = stored.data as { parentEventId?: number | null }
		expect(data.parentEventId).toBe(root.id)
	})
})
