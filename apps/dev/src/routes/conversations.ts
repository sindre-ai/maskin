import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	conversationParticipants,
	conversations,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	addConversationParticipantsSchema,
	conversationListQuerySchema,
	createConversationSchema,
	messageQuerySchema,
	postMessageSchema,
	updateConversationParticipantStateSchema,
	updateConversationSchema,
} from '@maskin/shared'
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	conversationDetailResponseSchema,
	conversationListItemResponseSchema,
	conversationParticipantStateResponseSchema,
	errorSchema,
	idParamSchema,
	messageResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { evaluateAndRespond } from '../services/conversation-responder'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
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

type ParticipantRow = {
	conversationId: string
	actorId: string
	actorName: string
	actorType: string
	joinedAt: Date | null
	addedBy: string | null
}

async function loadParticipantsByConversation(
	db: Database,
	conversationIds: string[],
): Promise<Map<string, ParticipantRow[]>> {
	if (conversationIds.length === 0) return new Map()
	const rows = await db
		.select({
			conversationId: conversationParticipants.conversationId,
			actorId: actors.id,
			actorName: actors.name,
			actorType: actors.type,
			joinedAt: conversationParticipants.joinedAt,
			addedBy: conversationParticipants.addedBy,
		})
		.from(conversationParticipants)
		.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
		.where(
			and(
				inArray(conversationParticipants.conversationId, conversationIds),
				isNull(conversationParticipants.leftAt),
			),
		)

	const byConversation = new Map<string, ParticipantRow[]>()
	for (const row of rows) {
		const list = byConversation.get(row.conversationId) ?? []
		list.push(row)
		byConversation.set(row.conversationId, list)
	}
	return byConversation
}

/** Batch version of isWorkspaceMember (workspace-auth.ts) for validating many actor ids at once. */
async function loadWorkspaceMemberIds(
	db: Database,
	workspaceId: string,
	actorIds: string[],
): Promise<Set<string>> {
	if (actorIds.length === 0) return new Set()
	const rows = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				inArray(workspaceMembers.actorId, actorIds),
			),
		)
	return new Set(rows.map((r) => r.actorId))
}

async function loadUnreadCounts(
	db: Database,
	callerId: string,
	conversationIds: string[],
): Promise<Map<string, number>> {
	if (conversationIds.length === 0) return new Map()
	const rows = await db
		.select({
			conversationId: messages.conversationId,
			unreadCount: sql<number>`count(*)::int`,
		})
		.from(messages)
		.innerJoin(
			conversationParticipants,
			and(
				eq(conversationParticipants.conversationId, messages.conversationId),
				eq(conversationParticipants.actorId, callerId),
			),
		)
		.where(
			and(
				inArray(messages.conversationId, conversationIds),
				ne(messages.actorId, callerId),
				sql`${messages.id} > COALESCE(${conversationParticipants.lastReadMessageId}, 0)`,
			),
		)
		.groupBy(messages.conversationId)
	return new Map(rows.map((r) => [r.conversationId, r.unreadCount]))
}

/** Load a conversation and verify the caller is an active (non-left) participant. */
async function loadConversationWithAuth(db: Database, conversationId: string, callerId: string) {
	const [row] = await db
		.select({
			conversation: conversations,
			participant: conversationParticipants,
		})
		.from(conversations)
		.innerJoin(
			conversationParticipants,
			and(
				eq(conversationParticipants.conversationId, conversations.id),
				eq(conversationParticipants.actorId, callerId),
				isNull(conversationParticipants.leftAt),
			),
		)
		.where(eq(conversations.id, conversationId))
		.limit(1)
	return row ?? null
}

// POST / - Create conversation
const createConversationRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Conversations'],
	summary: 'Create a conversation with one or more human/agent participants',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: createConversationSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: conversationDetailResponseSchema } },
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
	const sessionManager = c.get('sessionManager')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	// Every participant (including the creator, deduped) must already be a
	// workspace member — conversations don't extend membership, they're
	// scoped within it. isWorkspaceMember (workspace-auth.ts) checks one
	// actor at a time; batch it here since we may be validating dozens.
	const participantIds = Array.from(new Set([...body.participant_actor_ids, callerId]))
	const memberIds = await loadWorkspaceMemberIds(db, workspaceId, participantIds)
	const invalid = participantIds.filter((id) => !memberIds.has(id))
	if (invalid.length > 0) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'One or more participants are not members of this workspace',
				invalid.map((id) => ({ field: 'participant_actor_ids', message: `Not a member: ${id}` })),
			),
			400,
		)
	}

	const { conversation, initialMessage } = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(conversations)
			.values({ workspaceId, title: body.title, createdBy: callerId })
			.returning()
		if (!created) throw new Error('Failed to create conversation')

		await tx.insert(conversationParticipants).values(
			participantIds.map((actorId) => ({
				conversationId: created.id,
				actorId,
				addedBy: callerId,
			})),
		)

		let initialMessage: typeof messages.$inferSelect | undefined
		if (body.initial_message) {
			const [msg] = await tx
				.insert(messages)
				.values({ conversationId: created.id, actorId: callerId, content: body.initial_message })
				.returning()
			initialMessage = msg
			await tx
				.update(conversations)
				.set({ lastMessageAt: msg?.createdAt ?? new Date(), updatedAt: new Date() })
				.where(eq(conversations.id, created.id))
		}

		await tx.insert(events).values({
			workspaceId,
			actorId: callerId,
			action: 'conversation_created',
			entityType: 'conversation',
			entityId: created.id,
			data: { participant_actor_ids: participantIds },
		})

		return { conversation: created, initialMessage }
	})

	if (initialMessage) {
		evaluateAndRespond({
			db,
			sessionManager,
			workspaceId,
			conversationId: conversation.id,
			messageId: initialMessage.id,
		}).catch((err: unknown) =>
			logger.error('Conversation responder failed', {
				conversationId: conversation.id,
				messageId: initialMessage?.id,
				error: String(err),
			}),
		)
	}

	const participantsByConversation = await loadParticipantsByConversation(db, [conversation.id])
	return c.json(
		{
			...serialize(conversation),
			pinned: false,
			archived: false,
			unread_count: 0,
			last_read_message_id: null,
			participants: participantsByConversation.get(conversation.id) ?? [],
		} as z.infer<typeof conversationDetailResponseSchema>,
		201,
	)
}) as RouteHandler<typeof createConversationRoute, Env>)

// GET / - List caller's active conversations
const listConversationsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Conversations'],
	summary: "List the caller's conversations",
	request: { headers: workspaceIdHeader, query: conversationListQuerySchema },
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						conversations: z.array(conversationListItemResponseSchema),
						has_more: z.boolean(),
					}),
				},
			},
			description: 'List of conversations',
		},
	},
})

app.openapi(listConversationsRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const conditions = [
		eq(conversations.workspaceId, workspaceId),
		eq(conversationParticipants.actorId, callerId),
		isNull(conversationParticipants.leftAt),
		eq(conversationParticipants.archived, query.archived),
	]
	if (query.pinned !== undefined) conditions.push(eq(conversationParticipants.pinned, query.pinned))

	const rows = await db
		.select({ conversation: conversations, participant: conversationParticipants })
		.from(conversations)
		.innerJoin(
			conversationParticipants,
			eq(conversationParticipants.conversationId, conversations.id),
		)
		.where(and(...conditions))
		.orderBy(desc(conversationParticipants.pinned), desc(conversations.lastMessageAt))
		.limit(query.limit + 1)
		.offset(query.offset)

	const hasMore = rows.length > query.limit
	const page = rows.slice(0, query.limit)
	const conversationIds = page.map((r) => r.conversation.id)

	const [participantsByConversation, unreadRows, snippets] = await Promise.all([
		loadParticipantsByConversation(db, conversationIds),
		conversationIds.length === 0
			? Promise.resolve([])
			: db
					.select({
						conversationId: messages.conversationId,
						unreadCount: sql<number>`count(*)::int`,
					})
					.from(messages)
					.innerJoin(
						conversationParticipants,
						and(
							eq(conversationParticipants.conversationId, messages.conversationId),
							eq(conversationParticipants.actorId, callerId),
						),
					)
					.where(
						and(
							inArray(messages.conversationId, conversationIds),
							ne(messages.actorId, callerId),
							sql`${messages.id} > COALESCE(${conversationParticipants.lastReadMessageId}, 0)`,
						),
					)
					.groupBy(messages.conversationId),
		Promise.all(
			page.map(async (r) => {
				const [latest] = await db
					.select({ content: messages.content })
					.from(messages)
					.where(eq(messages.conversationId, r.conversation.id))
					.orderBy(desc(messages.id))
					.limit(1)
				return { conversationId: r.conversation.id, snippet: latest?.content ?? null }
			}),
		),
	])

	const unreadByConversation = new Map(unreadRows.map((r) => [r.conversationId, r.unreadCount]))
	const snippetByConversation = new Map(snippets.map((s) => [s.conversationId, s.snippet]))

	return c.json({
		conversations: page.map((r) => ({
			...serialize(r.conversation),
			pinned: r.participant.pinned,
			archived: r.participant.archived,
			unread_count: unreadByConversation.get(r.conversation.id) ?? 0,
			snippet: snippetByConversation.get(r.conversation.id) ?? null,
			participants: participantsByConversation.get(r.conversation.id) ?? [],
		})) as z.infer<typeof conversationListItemResponseSchema>[],
		has_more: hasMore,
	})
}) as RouteHandler<typeof listConversationsRoute, Env>)

// GET /:id - Conversation detail
const getConversationRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Conversations'],
	summary: 'Get a conversation (participants-only)',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: conversationDetailResponseSchema } },
			description: 'Conversation detail',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(getConversationRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const [participantsByConversation, unreadByConversation] = await Promise.all([
		loadParticipantsByConversation(db, [id]),
		loadUnreadCounts(db, callerId, [id]),
	])
	return c.json({
		...serialize(row.conversation),
		pinned: row.participant.pinned,
		archived: row.participant.archived,
		unread_count: unreadByConversation.get(id) ?? 0,
		last_read_message_id: row.participant.lastReadMessageId ?? null,
		participants: participantsByConversation.get(id) ?? [],
	} as z.infer<typeof conversationDetailResponseSchema>)
}) as RouteHandler<typeof getConversationRoute, Env>)

// PATCH /:id - Rename
const updateConversationRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['Conversations'],
	summary: 'Rename a conversation',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: updateConversationSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: conversationDetailResponseSchema } },
			description: 'Conversation updated',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(updateConversationRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const [updated] = await db
		.update(conversations)
		.set({ title: body.title, updatedAt: new Date() })
		.where(eq(conversations.id, id))
		.returning()
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'conversation_updated',
		entityType: 'conversation',
		entityId: id,
		data: { title: body.title },
	})

	const [participantsByConversation, unreadByConversation] = await Promise.all([
		loadParticipantsByConversation(db, [id]),
		loadUnreadCounts(db, callerId, [id]),
	])
	return c.json({
		...serialize(updated),
		pinned: row.participant.pinned,
		archived: row.participant.archived,
		unread_count: unreadByConversation.get(id) ?? 0,
		last_read_message_id: row.participant.lastReadMessageId ?? null,
		participants: participantsByConversation.get(id) ?? [],
	} as z.infer<typeof conversationDetailResponseSchema>)
}) as RouteHandler<typeof updateConversationRoute, Env>)

// POST /:id/participants - Add participant(s)
const addParticipantsRoute = createRoute({
	method: 'post',
	path: '/{id}/participants',
	tags: ['Conversations'],
	summary: 'Add participants to a conversation',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: addConversationParticipantsSchema } } },
	},
	responses: {
		200: {
			content: {
				'application/json': { schema: z.array(conversationParticipantStateResponseSchema) },
			},
			description: 'Updated participant list (state omitted — see GET /:id)',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(addParticipantsRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const memberIds = await loadWorkspaceMemberIds(db, workspaceId, body.actor_ids)
	const invalid = body.actor_ids.filter((actorId) => !memberIds.has(actorId))
	if (invalid.length > 0) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'One or more actors are not members of this workspace',
				invalid.map((actorId) => ({ field: 'actor_ids', message: `Not a member: ${actorId}` })),
			),
			400,
		)
	}

	for (const actorId of body.actor_ids) {
		await db
			.insert(conversationParticipants)
			.values({ conversationId: id, actorId, addedBy: callerId })
			.onConflictDoUpdate({
				target: [conversationParticipants.conversationId, conversationParticipants.actorId],
				// Re-adding a previously-removed participant clears leftAt but
				// deliberately keeps their prior pinned/archived/lastReadMessageId —
				// see schema comment on conversation_participants.
				set: { leftAt: null, addedBy: callerId, updatedAt: new Date() },
			})
	}

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'conversation_participant_added',
		entityType: 'conversation',
		entityId: id,
		data: { added_actor_ids: body.actor_ids },
	})

	const participantsByConversation = await loadParticipantsByConversation(db, [id])
	return c.json(participantsByConversation.get(id) ?? [])
}) as RouteHandler<typeof addParticipantsRoute, Env>)

// DELETE /:id/participants/:actorId - Remove / leave
const removeParticipantRoute = createRoute({
	method: 'delete',
	path: '/{id}/participants/{actorId}',
	tags: ['Conversations'],
	summary: 'Remove a participant from a conversation (or leave, if self)',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid(), actorId: z.string().uuid() }),
	},
	responses: {
		204: { description: 'Removed' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(removeParticipantRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, actorId } = c.req.valid('param')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	await db
		.update(conversationParticipants)
		.set({ leftAt: new Date(), updatedAt: new Date() })
		.where(
			and(
				eq(conversationParticipants.conversationId, id),
				eq(conversationParticipants.actorId, actorId),
			),
		)

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'conversation_participant_removed',
		entityType: 'conversation',
		entityId: id,
		data: { removed_actor_id: actorId },
	})

	return c.body(null, 204)
}) as RouteHandler<typeof removeParticipantRoute, Env>)

// GET /:id/messages - Paginated history
const listMessagesRoute = createRoute({
	method: 'get',
	path: '/{id}/messages',
	tags: ['Conversations'],
	summary: 'List messages in a conversation, newest-first',
	request: { headers: workspaceIdHeader, params: idParamSchema, query: messageQuerySchema },
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						messages: z.array(messageResponseSchema),
						has_more: z.boolean(),
					}),
				},
			},
			description: 'Messages',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(listMessagesRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const query = c.req.valid('query')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const conditions = [eq(messages.conversationId, id)]
	if (query.before_id) conditions.push(lt(messages.id, query.before_id))
	if (query.after_id) conditions.push(gt(messages.id, query.after_id))

	const rows = await db
		.select({
			id: messages.id,
			conversationId: messages.conversationId,
			actorId: messages.actorId,
			actorName: actors.name,
			actorType: actors.type,
			kind: messages.kind,
			content: messages.content,
			metadata: messages.metadata,
			sessionId: messages.sessionId,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(and(...conditions))
		.orderBy(desc(messages.id))
		.limit(query.limit + 1)

	const hasMore = rows.length > query.limit
	const page = rows.slice(0, query.limit)

	return c.json({
		messages: page.map((m) => serialize(m)) as z.infer<typeof messageResponseSchema>[],
		has_more: hasMore,
	})
}) as RouteHandler<typeof listMessagesRoute, Env>)

// POST /:id/messages - Post a message
const postMessageRoute = createRoute({
	method: 'post',
	path: '/{id}/messages',
	tags: ['Conversations'],
	summary: 'Post a message to a conversation',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: postMessageSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: messageResponseSchema } },
			description: 'Message posted',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(postMessageRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const callerId = c.get('actorId')
	const callerType = c.get('actorType')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	// Stamp session_id only when the caller is the agent that ran that
	// session, for this same conversation — otherwise silently drop it
	// rather than 400, since a stray/mismatched id here is almost always a
	// stale client, not a hostile one.
	let sessionId: string | null = null
	if (body.session_id && callerType === 'agent') {
		const isOwnSession = await db.execute(
			sql`SELECT 1 FROM sessions WHERE id = ${body.session_id} AND actor_id = ${callerId}
				AND workspace_id = ${workspaceId}
				AND config->'conversation'->>'conversation_id' = ${id} LIMIT 1`,
		)
		if (
			Array.isArray(isOwnSession)
				? isOwnSession.length > 0
				: (isOwnSession as { rows?: unknown[] }).rows?.length
		) {
			sessionId = body.session_id
		}
	}

	const [caller] = await db
		.select({ name: actors.name, type: actors.type })
		.from(actors)
		.where(eq(actors.id, callerId))
		.limit(1)

	const [created] = await db
		.insert(messages)
		.values({
			conversationId: id,
			actorId: callerId,
			content: body.content,
			metadata: body.metadata ?? null,
			sessionId,
		})
		.returning()
	if (!created) throw new Error('Failed to create message')

	await db
		.update(conversations)
		.set({ lastMessageAt: created.createdAt ?? new Date(), updatedAt: new Date() })
		.where(eq(conversations.id, id))

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'message_posted',
		entityType: 'conversation',
		entityId: id,
		data: { message_id: created.id, author_actor_id: callerId },
	})

	evaluateAndRespond({
		db,
		sessionManager,
		workspaceId,
		conversationId: id,
		messageId: created.id,
	}).catch((err: unknown) =>
		logger.error('Conversation responder failed', {
			conversationId: id,
			messageId: created.id,
			error: String(err),
		}),
	)

	return c.json(
		serialize({
			...created,
			actorName: caller?.name ?? 'Unknown',
			actorType: caller?.type ?? 'human',
		}) as z.infer<typeof messageResponseSchema>,
		201,
	)
}) as RouteHandler<typeof postMessageRoute, Env>)

// PATCH /:id/me - Caller's own pin/archive/read state
const updateMeRoute = createRoute({
	method: 'patch',
	path: '/{id}/me',
	tags: ['Conversations'],
	summary: "Update the caller's own pin/archive/read state for a conversation",
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: updateConversationParticipantStateSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: conversationParticipantStateResponseSchema } },
			description: 'Updated participant state',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(updateMeRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const setValues: Record<string, unknown> = { updatedAt: new Date() }
	if (body.pinned !== undefined) setValues.pinned = body.pinned
	if (body.archived !== undefined) setValues.archived = body.archived
	if (body.last_read_message_id !== undefined) {
		// GREATEST — read state never regresses even if updates race or arrive
		// out of order.
		setValues.lastReadMessageId = sql`GREATEST(COALESCE(${conversationParticipants.lastReadMessageId}, 0), ${body.last_read_message_id})`
	}

	const [updated] = await db
		.update(conversationParticipants)
		.set(setValues)
		.where(
			and(
				eq(conversationParticipants.conversationId, id),
				eq(conversationParticipants.actorId, callerId),
			),
		)
		.returning()
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)

	return c.json({
		pinned: updated.pinned,
		archived: updated.archived,
		last_read_message_id: updated.lastReadMessageId ?? null,
	} as z.infer<typeof conversationParticipantStateResponseSchema>)
}) as RouteHandler<typeof updateMeRoute, Env>)

export default app
