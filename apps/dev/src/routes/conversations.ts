import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	conversationParticipants,
	conversations,
	messages,
	sessions,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import {
	addParticipantSchema,
	createConversationSchema,
	messagesQuerySchema,
	sendMessageSchema,
} from '@maskin/shared'
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
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

const participantActorSchema = z.object({
	actorId: z.string().uuid(),
	name: z.string(),
	type: z.string(),
	isOnline: z.boolean(),
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
	unreadCount: z.number().int(),
	participants: z.array(participantActorSchema),
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

// GET / — last 5 conversations by last_activity_at, with participant count, unread count, and participant actors
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
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const participantCountSubquery = db
		.select({ cnt: count() })
		.from(conversationParticipants)
		.where(eq(conversationParticipants.conversationId, conversations.id))

	const unreadCountSubquery = db
		.select({ unread: conversationParticipants.unreadCount })
		.from(conversationParticipants)
		.where(
			and(
				eq(conversationParticipants.conversationId, conversations.id),
				eq(conversationParticipants.actorId, actorId),
			),
		)
		.limit(1)

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
			unreadCount: sql<number>`coalesce((${unreadCountSubquery}), 0)`,
		})
		.from(conversations)
		.where(eq(conversations.workspaceId, workspaceId))
		.orderBy(desc(conversations.lastActivityAt))
		.limit(5)

	// Fetch participant actors with online status (running session in workspace) for all returned conversations
	const conversationIds = rows.map((r) => r.id)
	const participantsByConversation = new Map<string, z.infer<typeof participantActorSchema>[]>()

	if (conversationIds.length > 0) {
		const participantRows = await db
			.select({
				conversationId: conversationParticipants.conversationId,
				actorId: actors.id,
				name: actors.name,
				type: actors.type,
				runningSession: sql<number>`count(${sessions.id}) filter (where ${sessions.status} = 'running')`,
			})
			.from(conversationParticipants)
			.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
			.leftJoin(
				sessions,
				and(eq(sessions.actorId, actors.id), eq(sessions.workspaceId, workspaceId)),
			)
			.where(inArray(conversationParticipants.conversationId, conversationIds))
			.groupBy(conversationParticipants.conversationId, actors.id, actors.name, actors.type)

		for (const pr of participantRows) {
			const list = participantsByConversation.get(pr.conversationId) ?? []
			list.push({
				actorId: pr.actorId,
				name: pr.name,
				type: pr.type,
				// Agents: online when they have a running session. Humans: always online.
				isOnline: pr.type === 'agent' ? Number(pr.runningSession) > 0 : true,
			})
			participantsByConversation.set(pr.conversationId, list)
		}
	}

	const result = rows.map((row) => ({
		...serialize(row),
		type: row.type as 'dm' | 'room',
		unreadCount: Number(row.unreadCount),
		participants: participantsByConversation.get(row.id) ?? [],
	}))

	logger.info('conversations listed', { workspaceId, count: rows.length })
	return c.json(result as z.infer<ReturnType<typeof conversationResponseSchema.array>>)
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
		unreadCount: 0,
		participants: [],
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

// POST /:id/messages — send a message, fire SSE event, handle @mention routing
const sendMessageRoute = createRoute({
	method: 'post',
	path: '/:id/messages',
	tags: ['Conversations'],
	summary: 'Send a message to a conversation',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: sendMessageSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: messageResponseSchema } },
			description: 'Message sent',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Conversation not found',
		},
	},
})

app.openapi(sendMessageRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const sessionManager = c.get('sessionManager')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const conversation = await loadConversationWithAuth(db, id, workspaceId)
	if (!conversation) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const preview = body.content.length > 100 ? `${body.content.slice(0, 100)}…` : body.content

	const { message, agentMentions } = await db.transaction(async (tx) => {
		const [msg] = await tx
			.insert(messages)
			.values({ conversationId: id, actorId, content: body.content })
			.returning()

		if (!msg) throw new Error('Failed to insert message')

		// Update conversation preview + activity timestamp
		await tx
			.update(conversations)
			.set({ lastMessagePreview: preview, lastActivityAt: new Date() })
			.where(eq(conversations.id, id))

		// Increment unread_count for all participants except the sender
		await tx
			.update(conversationParticipants)
			.set({ unreadCount: sql`${conversationParticipants.unreadCount} + 1` })
			.where(
				and(
					eq(conversationParticipants.conversationId, id),
					sql`${conversationParticipants.actorId} != ${actorId}`,
				),
			)

		// Insert SSE event — DB trigger fires pg_notify which the SSE stream picks up
		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: 'message_sent',
			entityType: 'conversation',
			entityId: id,
		})

		// Resolve @mentioned agent actors for session dispatch
		const mentions: Array<{ agentId: string; name: string }> = []
		if (body.mentions?.length) {
			const mentionedActors = await tx
				.select({ id: actors.id, type: actors.type, name: actors.name })
				.from(actors)
				.where(inArray(actors.id, body.mentions))

			for (const actor of mentionedActors) {
				if (actor.type === 'agent') {
					mentions.push({ agentId: actor.id, name: actor.name })
				}
			}
		}

		return { message: msg, agentMentions: mentions }
	})

	logger.info('message sent', { conversationId: id, messageId: message.id, workspaceId })

	// Fire-and-forget: spawn a session per @mentioned agent in the room context
	for (const mention of agentMentions) {
		sessionManager
			.createSession(workspaceId, {
				actorId: mention.agentId,
				actionPrompt: `You were @mentioned in conversation "${conversation.title ?? id}". Message: ${body.content}`,
				config: { conversation_id: id },
				createdBy: actorId,
				autoStart: true,
			})
			.catch((err: unknown) => {
				logger.error('Failed to spawn session for @mentioned agent in room', {
					agentId: mention.agentId,
					conversationId: id,
					err,
				})
			})
	}

	return c.json(serialize(message) as z.infer<typeof messageResponseSchema>, 201)
}) as RouteHandler<typeof sendMessageRoute, Env>)

// POST /:id/read — mark conversation as read for the current actor
const markReadRoute = createRoute({
	method: 'post',
	path: '/:id/read',
	tags: ['Conversations'],
	summary: 'Mark a conversation as read',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
			description: 'Marked as read',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Conversation not found',
		},
	},
})

app.openapi(markReadRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	const conversation = await loadConversationWithAuth(db, id, workspaceId)
	if (!conversation) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	await db
		.update(conversationParticipants)
		.set({ unreadCount: 0, lastReadAt: new Date() })
		.where(
			and(
				eq(conversationParticipants.conversationId, id),
				eq(conversationParticipants.actorId, actorId),
			),
		)

	logger.info('conversation marked read', { conversationId: id, actorId })
	return c.json({ ok: true })
}) as RouteHandler<typeof markReadRoute, Env>)

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
