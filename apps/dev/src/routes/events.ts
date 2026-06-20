import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, objects } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { createCommentSchema, eventQuerySchema } from '@maskin/shared'
import { and, asc, desc, eq, gt, gte, inArray, lt } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createApiError } from '../lib/errors'
import { errorSchema, eventResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serializeArray } from '../lib/serialize'
import { appendCommentEvent } from '../services/comments'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
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
		const parsedId = Number(lastEventId)
		if (lastEventId && !Number.isNaN(parsedId)) {
			const missed = await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, workspaceId), gt(events.id, parsedId)))
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
	if (query.id) conditions.push(eq(events.id, query.id))
	if (query.entity_type) conditions.push(eq(events.entityType, query.entity_type))
	if (query.entity_id) conditions.push(eq(events.entityId, query.entity_id))
	if (query.action) conditions.push(eq(events.action, query.action))
	if (query.since) conditions.push(gt(events.id, query.since))
	if (query.after) conditions.push(gte(events.createdAt, new Date(query.after)))
	if (query.before) conditions.push(lt(events.createdAt, new Date(query.before)))

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
	const sessionManager = c.get('sessionManager')
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

	// Validate any attached file IDs belong to this workspace before we commit
	// them onto the event row. Without this check an attacker could store IDs
	// of files they cannot read, and the renderer would still resolve and link
	// them for any workspace member who can see the comment.
	if (body.attachment_file_ids?.length) {
		const found = await db
			.select({ id: files.id })
			.from(files)
			.where(and(eq(files.workspaceId, workspaceId), inArray(files.id, body.attachment_file_ids)))

		if (found.length !== body.attachment_file_ids.length) {
			const foundIds = new Set(found.map((f) => f.id))
			const missing = body.attachment_file_ids.filter((id) => !foundIds.has(id))
			return c.json(
				createApiError('BAD_REQUEST', 'One or more attached files do not exist in this workspace', [
					{ field: 'attachment_file_ids', message: `Unknown file ids: ${missing.join(', ')}` },
				]),
				400,
			)
		}
	}

	const comment = await appendCommentEvent({
		db,
		sessionManager,
		workspaceId,
		actorId,
		entityType: 'object',
		entityId: body.entity_id,
		content: body.content,
		mentions: body.mentions,
		parentEventId: body.parent_event_id,
		attachmentFileIds: body.attachment_file_ids,
		metadata: body.metadata,
	})

	return c.json(serializeArray([comment])[0] as z.infer<typeof eventResponseSchema>, 201)
}) as RouteHandler<typeof createCommentRoute, Env>)

export default app
