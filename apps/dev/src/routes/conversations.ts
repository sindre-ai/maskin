import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, conversations, messages } from '@maskin/db/schema'
import { addParticipantSchema, createConversationSchema, messagesQuerySchema } from '@maskin/shared'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

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

const conversationResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	title: z.string().nullable(),
	type: z.enum(['dm', 'room']),
	lastMessagePreview: z.string().nullable(),
	lastActivityAt: z.string().nullable(),
	createdAt: z.string(),
	participantCount: z.number().int(),
})

const messageResponseSchema = z.object({
	id: z.string().uuid(),
	conversationId: z.string().uuid(),
	actorId: z.string().uuid(),
	content: z.string(),
	createdAt: z.string(),
})

const participantResponseSchema = z.object({
	conversationId: z.string().uuid(),
	actorId: z.string().uuid(),
	unreadCount: z.number().int(),
	lastReadAt: z.string().nullable(),
})

async function loadConversationWithAuth(db: Database, conversationId: string, workspaceId: string) {
	const [row] = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)))
		.limit(1)
	return row ?? null
}

// GET / — last 5 conversations by last_activity_at, with participant count
const listConversationsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Conversations'],
	summary: 'List recent conversations',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(conversationResponseSchema) } },
			description: 'List of conversations',
		},
	},
})

app.openapi(listConversationsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const participantCountSubquery = db
		.select({ cnt: count() })
		.from(conversationParticipants)
		.where(eq(conversationParticipants.conversationId, conversations.id))

	const rows = await db
		.select({
			id: conversations.id,
			workspaceId: conversations.workspaceId,
			title: conversations.title,
			type: conversations.type,
			lastMessagePreview: conversations.lastMessagePreview,
			lastActivityAt: conversations.lastActivityAt,
			createdAt: conversations.createdAt,
			participantCount: sql<number>`(${participantCountSubquery})`,
		})
		.from(conversations)
		.where(eq(conversations.workspaceId, workspaceId))
		.orderBy(desc(conversations.lastActivityAt))
		.limit(5)

	logger.info('conversations listed', { workspaceId, count: rows.length })
	return c.json(
		serializeArray(rows) as z.infer<ReturnType<typeof conversationResponseSchema.array>>,
	)
}) as RouteHandler<typeof listConversationsRoute, Env>)

// POST / — create conversation with participants
const createConversationRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Conversations'],
	summary: 'Create a conversation',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: createConversationSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: conversationResponseSchema } },
			description: 'Conversation created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(createConversationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const [conversation] = await db
		.insert(conversations)
		.values({
			workspaceId,
			title: body.title ?? null,
			type: body.type,
		})
		.returning()

	if (!conversation) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create conversation'), 500)
	}

	// Deduplicate participants and always include the caller
	const participantIds = [...new Set([actorId, ...body.participant_actor_ids])]
	await db.insert(conversationParticipants).values(
		participantIds.map((aid) => ({
			conversationId: conversation.id,
			actorId: aid,
		})),
	)

	logger.info('conversation created', { conversationId: conversation.id, workspaceId })

	const result = {
		...serialize(conversation),
		type: conversation.type as 'dm' | 'room',
		participantCount: participantIds.length,
	}
	return c.json(result as z.infer<typeof conversationResponseSchema>, 201)
}) as RouteHandler<typeof createConversationRoute, Env>)

// GET /:id/messages — paginated messages, newest-first
const listMessagesRoute = createRoute({
	method: 'get',
	path: '/:id/messages',
	tags: ['Conversations'],
	summary: 'List messages in a conversation',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		query: messagesQuerySchema,
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						data: z.array(messageResponseSchema),
						total: z.number().int(),
					}),
				},
			},
			description: 'Paginated message list',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Conversation not found',
		},
	},
})

app.openapi(listMessagesRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const { limit, offset } = c.req.valid('query')

	const conversation = await loadConversationWithAuth(db, id, workspaceId)
	if (!conversation) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const [rows, countRows] = await Promise.all([
		db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, id))
			.orderBy(desc(messages.createdAt))
			.limit(limit)
			.offset(offset),
		db.select({ cnt: count() }).from(messages).where(eq(messages.conversationId, id)),
	])

	const total = Number(countRows[0]?.cnt ?? 0)
	logger.info('messages listed', { conversationId: id, count: rows.length })
	return c.json({
		data: serializeArray(rows) as z.infer<typeof messageResponseSchema>[],
		total,
	})
}) as RouteHandler<typeof listMessagesRoute, Env>)

// POST /:id/participants — add a participant to a conversation
const addParticipantRoute = createRoute({
	method: 'post',
	path: '/:id/participants',
	tags: ['Conversations'],
	summary: 'Add a participant to a conversation',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: addParticipantSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: participantResponseSchema } },
			description: 'Participant added',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Conversation not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor is already a participant',
		},
	},
})

app.openapi(addParticipantRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const conversation = await loadConversationWithAuth(db, id, workspaceId)
	if (!conversation) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const [existing] = await db
		.select()
		.from(conversationParticipants)
		.where(
			and(
				eq(conversationParticipants.conversationId, id),
				eq(conversationParticipants.actorId, body.actor_id),
			),
		)
		.limit(1)

	if (existing) {
		return c.json(createApiError('CONFLICT', 'Actor is already a participant'), 409)
	}

	const [participant] = await db
		.insert(conversationParticipants)
		.values({ conversationId: id, actorId: body.actor_id })
		.returning()

	if (!participant) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to add participant'), 500)
	}

	logger.info('participant added', { conversationId: id, actorId: body.actor_id })
	return c.json(serialize(participant) as z.infer<typeof participantResponseSchema>, 201)
}) as RouteHandler<typeof addParticipantRoute, Env>)

export default app
