import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, subscriptions } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import {
	addParticipantSchema,
	conversationQuerySchema,
	createConversationSchema,
	createMessageSchema,
	messagesQuerySchema,
	participantIdParamSchema,
} from '@maskin/shared'
import { and, asc, desc, eq, lt } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	conversationParticipantResponseSchema,
	conversationResponseSchema,
	errorSchema,
	idParamSchema,
	messageResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'
import { appendCommentEvent } from '../services/comments'
import type { SessionManager } from '../services/session-manager'
import { autoSubscribe, isSubscribed } from '../services/subscriptions'

// Conversations live on the existing `objects` table with `type='conversation'`;
// messages are `events` rows with `action='commented'`; participants are
// `subscriptions` rows. This file is a thin facade — every mutation that
// matters at the multiplayer layer (mention-spawn, thread-reply auto-spawn,
// auto-subscribe, unread tracking) is inherited from the shared comment
// helper and the existing subscription service, so chat lives inside the
// same workspace event stream as bets, insights and tasks.
const CONVERSATION_TYPE = 'conversation'
const CONVERSATION_DEFAULT_STATUS = 'active'

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

// Workspace membership alone is not enough to read or write a conversation —
// the caller must be subscribed to the conversation object. Non-participants
// in the same workspace get the same 404 a stranger gets, so conversation IDs
// never leak across the room.
async function isActiveParticipant(
	db: Database,
	conversationId: string,
	actorId: string,
): Promise<boolean> {
	return isSubscribed(db, {
		actorId,
		entityType: 'object',
		entityId: conversationId,
	})
}

// POST /api/conversations — create a conversation object and seat the caller
// (author auto-subscription) plus any explicitly named co-participants.
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
			description: 'Conversation created',
			content: { 'application/json': { schema: conversationResponseSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createConversationRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	// `objects.metadata` shape for conversation objects (see
	// `conversationMetadataSchema` in @maskin/shared and T2 docs): kind +
	// auto_join live alongside any caller-provided extra metadata. The Zod
	// body keeps kind/auto_join as top-level inputs so the consumer doesn't
	// have to know about the metadata-bag convention.
	const conversationMetadata = {
		...(body.metadata ?? {}),
		...(body.kind ? { kind: body.kind } : {}),
		...(body.auto_join ? { auto_join: body.auto_join } : {}),
	}

	const [created] = await db
		.insert(objects)
		.values({
			workspaceId,
			type: CONVERSATION_TYPE,
			title: body.title ?? null,
			content: null,
			status: CONVERSATION_DEFAULT_STATUS,
			metadata: conversationMetadata,
			createdBy: actorId,
		})
		.returning()

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create conversation'), 500)
	}

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'object',
		entityId: created.id,
		data: created,
	})

	// Seat the author first so their source stays 'author' on conflict.
	await autoSubscribe(db, {
		workspaceId,
		actorId,
		entityType: 'object',
		entityId: created.id,
		source: 'author',
	})

	// Seat extra participants as `manual` subscriptions; dedup against the
	// caller (whose 'author' row would lose nothing on conflict but we skip
	// the redundant write).
	const coParticipants = Array.from(new Set(body.participant_actor_ids ?? [])).filter(
		(id) => id !== actorId,
	)
	for (const participantActorId of coParticipants) {
		await autoSubscribe(db, {
			workspaceId,
			actorId: participantActorId,
			entityType: 'object',
			entityId: created.id,
			source: 'manual',
		})
	}

	logger.info('Conversation created', {
		conversationId: created.id,
		workspaceId,
		actorId,
		coParticipantCount: coParticipants.length,
	})

	return c.json(serialize(created) as z.infer<typeof conversationResponseSchema>, 201)
})

// GET /api/conversations — list conversation objects the caller is
// subscribed to, ordered by recency.
const listConversationsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Conversations'],
	summary: 'List conversations the caller participates in',
	request: {
		headers: workspaceIdHeader,
		query: conversationQuerySchema,
	},
	responses: {
		200: {
			description: 'Conversations',
			content: { 'application/json': { schema: z.array(conversationResponseSchema) } },
		},
	},
})

app.openapi(listConversationsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { limit, offset } = c.req.valid('query')

	const rows = await db
		.select({
			id: objects.id,
			workspaceId: objects.workspaceId,
			title: objects.title,
			metadata: objects.metadata,
			createdBy: objects.createdBy,
			createdAt: objects.createdAt,
			updatedAt: objects.updatedAt,
		})
		.from(objects)
		.innerJoin(
			subscriptions,
			and(
				eq(subscriptions.entityType, 'object'),
				eq(subscriptions.entityId, objects.id),
				eq(subscriptions.actorId, actorId),
			),
		)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, CONVERSATION_TYPE)))
		.orderBy(desc(objects.updatedAt))
		.limit(limit)
		.offset(offset)

	return c.json(serializeArray(rows) as z.infer<typeof conversationResponseSchema>[])
}) as RouteHandler<typeof listConversationsRoute, Env>)

// GET /api/conversations/:id — fetch a single conversation object.
const getConversationRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Conversations'],
	summary: 'Get a conversation by ID',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Conversation',
			content: { 'application/json': { schema: conversationResponseSchema } },
		},
		404: {
			description: 'Conversation not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getConversationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [conversation] = await db
		.select()
		.from(objects)
		.where(and(eq(objects.id, id), eq(objects.type, CONVERSATION_TYPE)))
		.limit(1)

	if (!conversation || !(await isWorkspaceMember(db, actorId, conversation.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}
	if (!(await isActiveParticipant(db, id, actorId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	return c.json(serialize(conversation) as z.infer<typeof conversationResponseSchema>)
}) as RouteHandler<typeof getConversationRoute, Env>)

// POST /api/conversations/:id/messages — append a `commented` event against
// the conversation object. The shared `appendCommentEvent` helper auto-
// subscribes the commenter, threads replies under their root, fans out
// `needs_input` notifications + agent sessions for @mentions, and triggers
// thread-reply auto-spawn. All of that is the existing /api/events behaviour;
// this route only adds participant gating in front of it.
const postMessageRoute = createRoute({
	method: 'post',
	path: '/{id}/messages',
	tags: ['Conversations'],
	summary: 'Append a message to a conversation',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: createMessageSchema } } },
	},
	responses: {
		201: {
			description: 'Message appended',
			content: { 'application/json': { schema: messageResponseSchema } },
		},
		404: {
			description: 'Conversation not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(postMessageRoute, async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [conversation] = await db
		.select({ id: objects.id, workspaceId: objects.workspaceId })
		.from(objects)
		.where(and(eq(objects.id, id), eq(objects.type, CONVERSATION_TYPE)))
		.limit(1)

	if (!conversation || !(await isWorkspaceMember(db, actorId, conversation.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}
	if (!(await isActiveParticipant(db, id, actorId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const comment = await appendCommentEvent({
		db,
		sessionManager,
		workspaceId: conversation.workspaceId,
		actorId,
		entityType: 'object',
		entityId: conversation.id,
		content: body.content,
		mentions: body.mentions,
		parentEventId: body.parent_event_id,
		attachmentFileIds: body.attachment_file_ids,
		metadata: body.metadata,
	})

	logger.info('Conversation message appended', {
		conversationId: conversation.id,
		commentEventId: comment.id,
		workspaceId: conversation.workspaceId,
		actorId,
	})

	return c.json(toMessageResponse(comment, conversation.id), 201)
})

// GET /api/conversations/:id/messages — chronological list of `commented`
// events against the conversation object. `before_id` pages backwards using
// the monotonic `events.id` bigserial.
const listMessagesRoute = createRoute({
	method: 'get',
	path: '/{id}/messages',
	tags: ['Conversations'],
	summary: 'List messages in a conversation',
	request: {
		params: idParamSchema,
		query: messagesQuerySchema,
	},
	responses: {
		200: {
			description: 'Messages',
			content: { 'application/json': { schema: z.array(messageResponseSchema) } },
		},
		404: {
			description: 'Conversation not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listMessagesRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { limit, offset, before_id } = c.req.valid('query')

	const [conversation] = await db
		.select({ workspaceId: objects.workspaceId })
		.from(objects)
		.where(and(eq(objects.id, id), eq(objects.type, CONVERSATION_TYPE)))
		.limit(1)

	if (!conversation || !(await isWorkspaceMember(db, actorId, conversation.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}
	if (!(await isActiveParticipant(db, id, actorId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const conditions = [
		eq(events.entityType, 'object'),
		eq(events.entityId, id),
		eq(events.action, 'commented'),
	]
	if (before_id) {
		conditions.push(lt(events.id, before_id))
	}

	const rows = await db
		.select()
		.from(events)
		.where(and(...conditions))
		.orderBy(asc(events.id))
		.limit(limit)
		.offset(offset)

	return c.json(rows.map((row) => toMessageResponse(row, id)))
}) as RouteHandler<typeof listMessagesRoute, Env>)

// POST /api/conversations/:id/participants — seat a participant by inserting
// a `manual` subscription on the conversation object. Idempotent: existing
// rows are preserved by autoSubscribe's `onConflictDoNothing`.
const addParticipantRoute = createRoute({
	method: 'post',
	path: '/{id}/participants',
	tags: ['Conversations'],
	summary: 'Add a participant to a conversation',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: addParticipantSchema } } },
	},
	responses: {
		201: {
			description: 'Participant added',
			content: { 'application/json': { schema: conversationParticipantResponseSchema } },
		},
		404: {
			description: 'Conversation not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(addParticipantRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [conversation] = await db
		.select({ workspaceId: objects.workspaceId })
		.from(objects)
		.where(and(eq(objects.id, id), eq(objects.type, CONVERSATION_TYPE)))
		.limit(1)

	if (!conversation || !(await isWorkspaceMember(db, actorId, conversation.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}
	if (!(await isActiveParticipant(db, id, actorId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	await autoSubscribe(db, {
		workspaceId: conversation.workspaceId,
		actorId: body.actor_id,
		entityType: 'object',
		entityId: id,
		source: 'manual',
	})

	const [row] = await db
		.select({
			actorId: subscriptions.actorId,
			source: subscriptions.source,
			createdAt: subscriptions.createdAt,
		})
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.entityType, 'object'),
				eq(subscriptions.entityId, id),
				eq(subscriptions.actorId, body.actor_id),
			),
		)
		.limit(1)

	logger.info('Conversation participant added', {
		conversationId: id,
		participantActorId: body.actor_id,
		addedByActorId: actorId,
	})

	return c.json(
		{
			conversationId: id,
			actorId: body.actor_id,
			source: row?.source ?? 'manual',
			createdAt: row?.createdAt ? new Date(row.createdAt).toISOString() : null,
		} satisfies z.infer<typeof conversationParticipantResponseSchema>,
		201,
	)
})

// DELETE /api/conversations/:id/participants/:actorId — remove a
// participant by deleting their subscription row.
const removeParticipantRoute = createRoute({
	method: 'delete',
	path: '/{id}/participants/{actorId}',
	tags: ['Conversations'],
	summary: 'Remove a participant from a conversation',
	request: { params: participantIdParamSchema },
	responses: {
		200: {
			description: 'Participant removed',
			content: { 'application/json': { schema: conversationParticipantResponseSchema } },
		},
		404: {
			description: 'Conversation or participant not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(removeParticipantRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id, actorId: targetActorId } = c.req.valid('param')

	const [conversation] = await db
		.select({ workspaceId: objects.workspaceId })
		.from(objects)
		.where(and(eq(objects.id, id), eq(objects.type, CONVERSATION_TYPE)))
		.limit(1)

	if (!conversation || !(await isWorkspaceMember(db, callerId, conversation.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}
	if (!(await isActiveParticipant(db, id, callerId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const [removed] = await db
		.delete(subscriptions)
		.where(
			and(
				eq(subscriptions.entityType, 'object'),
				eq(subscriptions.entityId, id),
				eq(subscriptions.actorId, targetActorId),
			),
		)
		.returning({
			actorId: subscriptions.actorId,
			source: subscriptions.source,
			createdAt: subscriptions.createdAt,
		})

	if (!removed) {
		return c.json(createApiError('NOT_FOUND', 'Participant not found'), 404)
	}

	logger.info('Conversation participant removed', {
		conversationId: id,
		participantActorId: targetActorId,
		removedByActorId: callerId,
	})

	return c.json({
		conversationId: id,
		actorId: removed.actorId,
		source: removed.source,
		createdAt: removed.createdAt ? new Date(removed.createdAt).toISOString() : null,
	} satisfies z.infer<typeof conversationParticipantResponseSchema>)
}) as RouteHandler<typeof removeParticipantRoute, Env>)

// GET /api/conversations/:id/participants — list subscription rows for the
// conversation object.
const listParticipantsRoute = createRoute({
	method: 'get',
	path: '/{id}/participants',
	tags: ['Conversations'],
	summary: 'List participants of a conversation',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Participants',
			content: {
				'application/json': { schema: z.array(conversationParticipantResponseSchema) },
			},
		},
		404: {
			description: 'Conversation not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listParticipantsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [conversation] = await db
		.select({ workspaceId: objects.workspaceId })
		.from(objects)
		.where(and(eq(objects.id, id), eq(objects.type, CONVERSATION_TYPE)))
		.limit(1)

	if (!conversation || !(await isWorkspaceMember(db, actorId, conversation.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}
	if (!(await isActiveParticipant(db, id, actorId))) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const rows = await db
		.select({
			actorId: subscriptions.actorId,
			source: subscriptions.source,
			createdAt: subscriptions.createdAt,
		})
		.from(subscriptions)
		.where(and(eq(subscriptions.entityType, 'object'), eq(subscriptions.entityId, id)))

	return c.json(
		rows.map(
			(row) =>
				({
					conversationId: id,
					actorId: row.actorId,
					source: row.source,
					createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
				}) satisfies z.infer<typeof conversationParticipantResponseSchema>,
		),
	)
}) as RouteHandler<typeof listParticipantsRoute, Env>)

// Pull conversation-message-shaped fields out of an event row. The
// `events.data` JSON bag carries content / mentions / parentEventId /
// attachmentFileIds / metadata — see appendCommentEvent for the writer side.
function toMessageResponse(
	event: {
		id: number
		workspaceId: string
		actorId: string
		data: unknown
		createdAt: Date | null
	},
	conversationId: string,
): z.infer<typeof messageResponseSchema> {
	const data = (event.data ?? {}) as {
		content?: string
		mentions?: string[] | null
		parentEventId?: number | null
		attachmentFileIds?: string[] | null
		metadata?: Record<string, unknown> | null
	}
	return {
		id: event.id,
		workspaceId: event.workspaceId,
		conversationId,
		actorId: event.actorId,
		content: data.content ?? '',
		mentions: data.mentions ?? null,
		parentEventId: data.parentEventId ?? null,
		attachmentFileIds: data.attachmentFileIds ?? null,
		metadata: (data.metadata ?? null) as z.infer<typeof messageResponseSchema>['metadata'],
		createdAt: event.createdAt ? new Date(event.createdAt).toISOString() : null,
	}
}

export default app
