import type { Database } from '@ai-native/db'
import { events, actors, notifications, objects } from '@ai-native/db/schema'
import type { PgEvent, PgNotifyBridge } from '@ai-native/realtime'
import { createCommentSchema, eventQuerySchema } from '@ai-native/shared'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createApiError } from '../lib/errors'
import { errorSchema, eventResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serializeArray } from '../lib/serialize'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const app = new OpenAPIHono<Env>()

// GET /api/events - SSE stream (plain Hono, not OpenAPI)
app.get('/', async (c) => {
	const db = c.get('db')
	const bridge = c.get('notifyBridge')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId)
		return c.json(
			createApiError('BAD_REQUEST', 'X-Workspace-Id header required', [
				{ field: 'x-workspace-id', message: 'Required header is missing', expected: 'UUID string' },
			]),
			400,
		)

	const lastEventId = c.req.header('Last-Event-ID')

	return streamSSE(c, async (stream) => {
		// Replay missed events if Last-Event-ID is provided
		if (lastEventId) {
			const missed = await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, workspaceId), gt(events.id, Number(lastEventId))))
				.orderBy(asc(events.id))
				.limit(100)

			for (const event of missed) {
				await stream.writeSSE({
					id: String(event.id),
					event: event.action,
					data: JSON.stringify(event),
				})
			}
		}

		// Listen for new events
		const handler = (event: PgEvent) => {
			if (event.workspace_id !== workspaceId) return

			stream.writeSSE({
				id: event.event_id,
				event: event.action,
				data: JSON.stringify(event),
			})
		}

		bridge.on('event', handler)

		stream.onAbort(() => {
			bridge.off('event', handler)
		})

		// Keep connection alive
		while (true) {
			await stream.sleep(30000)
		}
	})
})

// GET /api/events/history - Paginated event history
const eventHistoryRoute = createRoute({
	method: 'get',
	path: '/history',
	tags: ['events'],
	summary: 'Paginated event history',
	request: {
		headers: workspaceIdHeader,
		query: eventQuerySchema,
	},
	responses: {
		200: {
			description: 'List of events',
			content: { 'application/json': { schema: z.array(eventResponseSchema) } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(eventHistoryRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const conditions = [eq(events.workspaceId, workspaceId)]
	if (query.entity_type) conditions.push(eq(events.entityType, query.entity_type))
	if (query.entity_id) conditions.push(eq(events.entityId, query.entity_id))
	if (query.action) conditions.push(eq(events.action, query.action))
	if (query.since) conditions.push(gt(events.id, query.since))

	const results = await db
		.select()
		.from(events)
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(desc(events.createdAt))

	return c.json(serializeArray(results) as z.infer<typeof eventResponseSchema>[])
}) as RouteHandler<typeof eventHistoryRoute, Env>)

// POST /api/events - Create a comment event
const createCommentRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['events'],
	summary: 'Create a comment on an object',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: createCommentSchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Comment event created',
			content: { 'application/json': { schema: eventResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createCommentRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	// Validate the target object exists and belongs to this workspace
	const [object] = await db
		.select({ workspaceId: objects.workspaceId })
		.from(objects)
		.where(eq(objects.id, body.entity_id))
		.limit(1)

	if (!object || object.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404 as never)
	}

	const results = await db
		.insert(events)
		.values({
			workspaceId,
			actorId,
			action: 'commented',
			entityType: 'object',
			entityId: body.entity_id,
			data: {
				content: body.content,
				mentions: body.mentions,
				parentEventId: body.parent_event_id,
			},
		})
		.returning()

	const created = results[0]
	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create comment'), 500 as never)
	}

	// Create notifications for @mentioned agents (batched)
	if (body.mentions?.length) {
		const mentionedActors = await db
			.select({ id: actors.id, type: actors.type, name: actors.name })
			.from(actors)
			.where(inArray(actors.id, body.mentions))

		const agentActors = mentionedActors.filter((a) => a.type === 'agent')

		if (agentActors.length > 0) {
			const createdNotifications = await db
				.insert(notifications)
				.values(
					agentActors.map((agent) => ({
						workspaceId,
						type: 'needs_input' as const,
						title: '@mentioned by comment',
						content: body.content,
						sourceActorId: actorId,
						targetActorId: agent.id,
						objectId: body.entity_id,
						status: 'pending' as const,
					})),
				)
				.returning()

			if (createdNotifications.length > 0) {
				await db.insert(events).values(
					createdNotifications.map((notification) => ({
						workspaceId,
						actorId,
						action: 'created',
						entityType: 'notification',
						entityId: notification.id,
						data: notification,
					})),
				)
			}
		}
	}

	return c.json(serializeArray([created])[0] as z.infer<typeof eventResponseSchema>, 201)
}) as RouteHandler<typeof createCommentRoute, Env>)

export default app
