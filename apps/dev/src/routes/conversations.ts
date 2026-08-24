import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	conversationBranches,
	conversationParticipants,
	conversations,
	messages,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	addConversationParticipantsSchema,
	conversationListQuerySchema,
	createConversationSchema,
	editMessageSchema,
	messageQuerySchema,
	postMessageSchema,
	stripServerOwnedMetadata,
	updateConversationParticipantStateSchema,
	updateConversationSchema,
} from '@maskin/shared'
import type { MessageMetadata } from '@maskin/shared'
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	branchPointResponseSchema,
	conversationDetailResponseSchema,
	conversationListItemResponseSchema,
	conversationParticipantStateResponseSchema,
	errorSchema,
	idParamSchema,
	messageResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import {
	type BranchId,
	activeBranchCondition,
	buildBranchPoints,
	loadBranchRows,
	loadFirstMessageIdByBranch,
	multiConversationVisibilityCondition,
} from '../services/conversation-branches'
import { insertConversationMessage } from '../services/conversation-messages'
import { evaluateAndRespond } from '../services/conversation-responder'
import { resolveConversationResumeTargets } from '../services/conversation-rewind'
import { maybeGenerateConversationTitle } from '../services/conversation-titler'
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

/**
 * Unread counts, restricted to each conversation's active branch. A tail the
 * user rewound away must not keep showing as unread — the messages still exist,
 * they are just no longer part of the thread anyone is reading.
 *
 * `activeBranchByConversation` is threaded in by callers that already hold the
 * conversation rows, so the common (unbranched) path adds no query at all.
 */
async function loadUnreadCounts(
	db: Database,
	callerId: string,
	conversationIds: string[],
	activeBranchByConversation: Map<string, BranchId>,
): Promise<Map<string, number>> {
	if (conversationIds.length === 0) return new Map()
	const branchCondition = multiConversationVisibilityCondition(
		await loadBranchRows(db, conversationIds),
		activeBranchByConversation,
	)
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
				branchCondition,
			),
		)
		.groupBy(messages.conversationId)
	return new Map(rows.map((r) => [r.conversationId, r.unreadCount]))
}

/**
 * Inserts (or re-activates, via onConflictDoUpdate) active participant rows.
 * Re-adding a previously-removed participant clears leftAt but deliberately
 * keeps their prior pinned/archived/lastReadMessageId — see schema comment on
 * conversation_participants. Shared by the explicit add-participants route and
 * the @mention auto-join path in postMessageRoute.
 */
async function addParticipantsToConversation(
	db: Database,
	conversationId: string,
	actorIds: string[],
	addedBy: string,
): Promise<void> {
	for (const actorId of actorIds) {
		await db
			.insert(conversationParticipants)
			.values({ conversationId, actorId, addedBy })
			.onConflictDoUpdate({
				target: [conversationParticipants.conversationId, conversationParticipants.actorId],
				set: { leftAt: null, addedBy, updatedAt: new Date() },
			})
	}
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

/**
 * Stop every live interactive session attached to a conversation.
 *
 * Called when the thread's shape changes underneath the agents — a rewind or a
 * branch switch. Their CLI processes hold the pre-change transcript in memory,
 * and no amount of filtering on our side removes it; the only way to make an
 * agent forget a discarded tail is to end the session. The responder then spawns
 * a fresh one, seeded from the branch-filtered history.
 *
 * Best-effort by design: a session that refuses to stop still hits its own idle
 * (CHAT_IDLE_CLOSE_MS) or timeout backstop, and must not fail the user's rewind.
 */
async function stopConversationSessions(
	db: Database,
	sessionManager: SessionManager,
	conversationId: string,
	options: { awaitSnapshot?: boolean } = {},
): Promise<void> {
	const live = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.conversationId, conversationId),
				eq(sessions.interactive, true),
				inArray(sessions.status, ['pending', 'starting', 'running']),
			),
		)

	await Promise.all(
		live.map(async (session) => {
			try {
				await sessionManager.stopSession(session.id)
				// stopSession returns as soon as the container is asked to stop;
				// the workspace snapshot (which carries the CLI transcript) is
				// written later, from the exit watcher. A rewind restores from
				// that snapshot via sourceSessionId, so it has to wait for it —
				// otherwise the replacement session reliably finds nothing and
				// falls back to a cold start, defeating the resume entirely.
				if (options.awaitSnapshot) await sessionManager.waitForWorkspaceSnapshot(session.id)
			} catch (err: unknown) {
				logger.warn('Failed to stop interactive session during conversation rewind', {
					conversationId,
					sessionId: session.id,
					error: String(err),
				})
			}
		}),
	)
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
				.values({
					conversationId: created.id,
					actorId: callerId,
					content: body.initial_message,
					metadata: stripServerOwnedMetadata(body.initial_message_metadata) ?? null,
				})
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
		// Independent of the responder, not chained to it: a slow or failing
		// agent reply must not delay the title replacing its placeholder.
		maybeGenerateConversationTitle({ db, workspaceId, conversationId: conversation.id }).catch(
			(err: unknown) =>
				logger.error('Conversation auto-title failed', {
					conversationId: conversation.id,
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
	if (query.unread_only) {
		// Table names (not Drizzle column refs) inside the correlated subquery —
		// interpolating column objects here renders unqualified and silently
		// binds to the inner `messages` alias for names both tables share (see
		// known-pitfalls.md's correlated-subquery entry).
		conditions.push(
			sql`EXISTS (
				SELECT 1 FROM messages m
				WHERE m.conversation_id = conversations.id
					AND m.actor_id != ${callerId}
					AND m.id > COALESCE(conversation_participants.last_read_message_id, 0)
			)`,
		)
	}

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

	// One branch fetch for the whole page, reused by both the unread aggregate
	// and the per-conversation snippet, so a branched workspace doesn't turn the
	// list into an N+1.
	const activeBranchByConversation = new Map<string, BranchId>(
		page.map((r) => [r.conversation.id, r.conversation.activeBranchId]),
	)
	const branchRowsByConversation = await loadBranchRows(db, conversationIds)
	const listBranchCondition = multiConversationVisibilityCondition(
		branchRowsByConversation,
		activeBranchByConversation,
	)

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
							listBranchCondition,
						),
					)
					.groupBy(messages.conversationId),
		Promise.all(
			page.map(async (r) => {
				const [latest] = await db
					.select({ content: messages.content })
					.from(messages)
					.where(and(eq(messages.conversationId, r.conversation.id), listBranchCondition))
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
		loadUnreadCounts(db, callerId, [id], new Map([[id, row.conversation.activeBranchId]])),
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
		// A human rename permanently opts the conversation out of auto-titling
		// (conversation-titler.ts) — otherwise the refinement pass would
		// overwrite whatever they just typed.
		.set({ title: body.title, titleAutoState: 'manual', updatedAt: new Date() })
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
		loadUnreadCounts(db, callerId, [id], new Map([[id, updated.activeBranchId]])),
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

	await addParticipantsToConversation(db, id, body.actor_ids, callerId)

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
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not permitted to remove this participant',
		},
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

	// Only self-removal (leaving) or the conversation creator removing someone
	// else is allowed — a regular participant may not evict another.
	if (callerId !== actorId && row.conversation.createdBy !== callerId) {
		return c.json(
			createApiError('FORBIDDEN', 'Only the conversation creator can remove other participants'),
			403,
		)
	}

	const removed = await db
		.update(conversationParticipants)
		.set({ leftAt: new Date(), updatedAt: new Date() })
		.where(
			and(
				eq(conversationParticipants.conversationId, id),
				eq(conversationParticipants.actorId, actorId),
				isNull(conversationParticipants.leftAt),
			),
		)
		.returning({ actorId: conversationParticipants.actorId })

	if (removed.length > 0) {
		await db.insert(events).values({
			workspaceId,
			actorId: callerId,
			action: 'conversation_participant_removed',
			entityType: 'conversation',
			entityId: id,
			data: { removed_actor_id: actorId },
		})
	}

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
						active_branch_id: z.string().uuid().nullable(),
						branch_points: z.array(branchPointResponseSchema),
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

	// Only the active branch. Rewound-away messages stay in the table and stay
	// reachable by switching branches — they are just not part of this thread.
	const conditions = [eq(messages.conversationId, id), await activeBranchCondition(db, id)]
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
			editedAt: messages.editedAt,
		})
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(and(...conditions))
		.orderBy(desc(messages.id))
		.limit(query.limit + 1)

	const hasMore = rows.length > query.limit
	const page = rows.slice(0, query.limit)

	// Rewinding discards everything after the target, so it is offered only past
	// the last message anyone else wrote. One aggregate here beats re-deriving
	// the rule per message on the client — and it is the same rule the rewind
	// endpoint enforces, so the button can't offer something the API refuses.
	const [lastOtherHuman] = await db
		.select({ id: messages.id })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(
			and(
				eq(messages.conversationId, id),
				eq(messages.kind, 'message'),
				ne(messages.actorId, callerId),
				eq(actors.type, 'human'),
				await activeBranchCondition(db, id),
			),
		)
		.orderBy(desc(messages.id))
		.limit(1)
	const rewindFloor = lastOtherHuman?.id ?? 0

	const activeBranchId = row.conversation.activeBranchId
	const [branchRows, firstMessageIdByBranch] = await Promise.all([
		loadBranchRows(db, [id]),
		loadFirstMessageIdByBranch(db, id),
	])
	const branchPoints = buildBranchPoints(
		branchRows.get(id) ?? [],
		activeBranchId,
		firstMessageIdByBranch,
	)

	return c.json({
		messages: page.map((m) =>
			serialize({
				...m,
				canRewind: m.actorId === callerId && m.kind === 'message' && m.id > rewindFloor,
			}),
		) as z.infer<typeof messageResponseSchema>[],
		has_more: hasMore,
		active_branch_id: activeBranchId,
		branch_points: branchPoints,
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
		const [ownSession] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.id, body.session_id),
					eq(sessions.actorId, callerId),
					eq(sessions.workspaceId, workspaceId),
					eq(sessions.conversationId, id),
				),
			)
			.limit(1)
		if (ownSession) {
			sessionId = body.session_id
		}
	}

	const [caller] = await db
		.select({ name: actors.name, type: actors.type })
		.from(actors)
		.where(eq(actors.id, callerId))
		.limit(1)

	// `source` / `final_output` are backend-owned markers for auto-posted
	// end-of-turn output. A client (or an agent via the MCP tool) must not be
	// able to claim them — the frontend reconciles its optimistic bubble
	// against `source`, so a forged one would strand that bubble forever.
	const metadata = stripServerOwnedMetadata(body.metadata) ?? null

	const created = await insertConversationMessage(db, {
		conversationId: id,
		workspaceId,
		actorId: callerId,
		content: body.content,
		metadata,
		sessionId,
	})
	if (!created) throw new Error('Failed to create message')

	// @mentioning an agent who isn't yet an active participant should actually
	// pull them into the conversation — otherwise evaluateAndRespond's
	// candidate query (scoped to active conversationParticipants) never sees
	// them and the mention silently does nothing. Auto-join here, before
	// evaluateAndRespond runs, so the freshly-mentioned agent is already a
	// candidate for this very message.
	const mentionedIds = metadata?.mentions ?? []
	if (mentionedIds.length > 0) {
		const activeParticipants = await loadParticipantsByConversation(db, [id])
		const activeIds = new Set((activeParticipants.get(id) ?? []).map((p) => p.actorId))
		const notYetJoined = mentionedIds.filter((actorId) => !activeIds.has(actorId))
		if (notYetJoined.length > 0) {
			const memberIds = await loadWorkspaceMemberIds(db, workspaceId, notYetJoined)
			const toAdd = notYetJoined.filter((actorId) => memberIds.has(actorId))
			if (toAdd.length > 0) {
				await addParticipantsToConversation(db, id, toAdd, callerId)
				await db.insert(events).values({
					workspaceId,
					actorId: callerId,
					action: 'conversation_participant_added',
					entityType: 'conversation',
					entityId: id,
					data: { added_actor_ids: toAdd, via: 'mention' },
				})
			}
		}
	}

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

	// Independent of the responder, not chained to it: a slow or failing agent
	// reply must not delay the title. No-ops unless this conversation is due
	// for its initial or refined title (see conversation-titler.ts).
	maybeGenerateConversationTitle({ db, workspaceId, conversationId: id }).catch((err: unknown) =>
		logger.error('Conversation auto-title failed', { conversationId: id, error: String(err) }),
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

// PATCH /:id/messages/:messageId - Edit an own message
const editMessageRoute = createRoute({
	method: 'patch',
	path: '/{id}/messages/{messageId}',
	tags: ['Conversations'],
	summary: 'Edit a message you authored',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid(), messageId: z.coerce.number().int().positive() }),
		body: { content: { 'application/json': { schema: editMessageSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: messageResponseSchema } },
			description: 'Message updated',
		},
		403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not author' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(editMessageRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, messageId } = c.req.valid('param')
	const body = c.req.valid('json')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const [message] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.conversationId, id)))
		.limit(1)
	if (!message || message.kind !== 'message') {
		return c.json(createApiError('NOT_FOUND', 'Message not found'), 404)
	}
	if (message.actorId !== callerId) {
		return c.json(createApiError('FORBIDDEN', 'Only the author can edit a message'), 403)
	}
	// An agent's auto-posted end-of-turn reply is a session artifact, not an
	// editable authored message.
	if ((message.metadata as { source?: string } | null)?.source === 'final_output') {
		return c.json(createApiError('FORBIDDEN', 'Auto-posted agent output cannot be edited'), 403)
	}

	const editedAt = new Date()
	const [updated] = await db
		.update(messages)
		.set({ content: body.content, editedAt })
		.where(eq(messages.id, messageId))
		.returning()
	if (!updated) throw new Error('Failed to update message')

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'message_updated',
		entityType: 'conversation',
		entityId: id,
		data: { message_id: messageId },
	})

	// Re-notify agents only when the edited message is still the newest real
	// message in the conversation — a correction of the message they are (or
	// should be) responding to. Editing something further up is a silent fix;
	// re-running the responder for it would produce a confusing out-of-order
	// agent turn.
	const [newest] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, id),
				eq(messages.kind, 'message'),
				await activeBranchCondition(db, id),
			),
		)
		.orderBy(desc(messages.id))
		.limit(1)
	if (newest?.id === messageId) {
		evaluateAndRespond({
			db,
			sessionManager,
			workspaceId,
			conversationId: id,
			messageId,
			options: { isEdit: true },
		}).catch((err: unknown) =>
			logger.error('Conversation responder failed after edit', {
				conversationId: id,
				messageId,
				error: String(err),
			}),
		)
	}

	const [caller] = await db
		.select({ name: actors.name, type: actors.type })
		.from(actors)
		.where(eq(actors.id, callerId))
		.limit(1)

	return c.json(
		serialize({
			...updated,
			actorName: caller?.name ?? 'Unknown',
			actorType: caller?.type ?? 'human',
		}) as z.infer<typeof messageResponseSchema>,
		200,
	)
}) as RouteHandler<typeof editMessageRoute, Env>)

// POST /:id/messages/:messageId/retry - Ask agents to respond to a message again
const retryMessageRoute = createRoute({
	method: 'post',
	path: '/{id}/messages/{messageId}/retry',
	tags: ['Conversations'],
	summary: 'Re-run the agent responder for a message (force a reply)',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid(), messageId: z.coerce.number().int().positive() }),
		// agent_id scopes the retry to one agent — set by "Redo this response",
		// where fanning out to every participant would post duplicate replies.
		query: z.object({ agent_id: z.string().uuid().optional() }),
	},
	responses: {
		202: {
			content: { 'application/json': { schema: z.object({ retried: z.boolean() }) } },
			description: 'Responder re-triggered',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(retryMessageRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, messageId } = c.req.valid('param')
	const { agent_id: targetAgentId } = c.req.valid('query')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const [message] = await db
		.select({ id: messages.id, kind: messages.kind })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.conversationId, id)))
		.limit(1)
	if (!message || message.kind !== 'message') {
		return c.json(createApiError('NOT_FOUND', 'Message not found'), 404)
	}

	// forceRespond: an explicit human retry overrides the relevance heuristic —
	// the user is asking for a reply, not for agents to decide whether one is
	// warranted. Delivery is idempotent per (conversation, agent, message) at
	// the pending-turn layer; a live session simply receives the turn again.
	evaluateAndRespond({
		db,
		sessionManager,
		workspaceId,
		conversationId: id,
		messageId,
		options: { forceRespond: true, targetAgentId },
	}).catch((err: unknown) =>
		logger.error('Conversation responder failed on retry', {
			conversationId: id,
			messageId,
			error: String(err),
		}),
	)

	return c.json({ retried: true }, 202)
}) as RouteHandler<typeof retryMessageRoute, Env>)

// POST /:id/messages/:messageId/rewind - Rewind the thread to a message and re-run
//
// The "redo" button. Unlike /retry (which re-asks agents to answer an existing
// message, leaving the thread intact), rewind forks: everything from the target
// message onward moves off the live thread onto the parent branch, a copy of
// the target message is re-posted on a fresh branch, and the agents answer it
// again with no memory of the discarded tail.
//
// Nothing is deleted. The old tail stays queryable by switching branches.
const rewindMessageRoute = createRoute({
	method: 'post',
	path: '/{id}/messages/{messageId}/rewind',
	tags: ['Conversations'],
	summary: 'Rewind a conversation to a message and re-send it on a new branch',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid(), messageId: z.coerce.number().int().positive() }),
	},
	responses: {
		202: {
			content: {
				'application/json': {
					schema: z.object({ branch_id: z.string().uuid(), message: messageResponseSchema }),
				},
			},
			description: 'Rewound; responder re-triggered',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not the author',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Another person has replied since',
		},
	},
})

app.openapi(rewindMessageRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, messageId } = c.req.valid('param')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	// Resolve visibility once and reuse it: the target must be on the branch the
	// caller is actually looking at, and the "has anyone replied since" guard
	// must not be tripped by messages on a branch they navigated away from.
	const branchCondition = await activeBranchCondition(db, id)

	const [message] = await db
		.select({ id: messages.id, kind: messages.kind, actorId: messages.actorId })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.conversationId, id), branchCondition))
		.limit(1)
	if (!message || message.kind !== 'message') {
		return c.json(createApiError('NOT_FOUND', 'Message not found'), 404)
	}
	if (message.actorId !== callerId) {
		return c.json(createApiError('FORBIDDEN', 'Only the author of a message can rewind to it'), 403)
	}

	// Rewinding discards the tail for everyone in the conversation, so it is only
	// offered while that tail is the caller's own exchange with agents. Another
	// person's message in between makes this destructive to them; agent replies
	// do not, since re-running them is exactly what the caller is asking for.
	const [blocker] = await db
		.select({ id: messages.id })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(
			and(
				eq(messages.conversationId, id),
				gt(messages.id, messageId),
				eq(messages.kind, 'message'),
				ne(messages.actorId, callerId),
				eq(actors.type, 'human'),
				branchCondition,
			),
		)
		.limit(1)
	if (blocker) {
		return c.json(
			createApiError(
				'CONFLICT',
				'Someone else has replied since this message — rewinding would remove their message from the thread.',
			),
			409,
		)
	}

	const [branch] = await db
		.insert(conversationBranches)
		.values({
			conversationId: id,
			parentBranchId: row.conversation.activeBranchId,
			forkedFromMessageId: messageId,
			createdBy: callerId,
		})
		.returning()
	if (!branch) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create branch'), 500)
	}

	await db
		.update(conversations)
		.set({ activeBranchId: branch.id, updatedAt: new Date() })
		.where(eq(conversations.id, id))

	// Re-post the target onto the new branch. The original stays put on the
	// parent branch — switching back shows the thread exactly as it was.
	const [original] = await db
		.select({ content: messages.content, metadata: messages.metadata })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1)
	const created = await insertConversationMessage(db, {
		conversationId: id,
		workspaceId,
		actorId: callerId,
		content: original?.content ?? '',
		metadata: (original?.metadata as MessageMetadata | null) ?? null,
		sessionId: null,
		branchId: branch.id,
	})
	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to re-post message'), 500)
	}

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'conversation_rewound',
		entityType: 'conversation',
		entityId: id,
		data: {
			branch_id: branch.id,
			parent_branch_id: row.conversation.activeBranchId,
			rewound_to_message_id: messageId,
			new_message_id: created.id,
		},
	})

	// Work out where each agent's CLI transcript should be re-opened BEFORE
	// stopping anything — this reads the live sessions' cliSessionId and their
	// delivered-turn log.
	const resumeTargets = await resolveConversationResumeTargets(db, id, messageId)

	// Then drop the live sessions. Their CLI processes hold the discarded tail in
	// memory, and no amount of DB filtering removes it; ending the session is the
	// only way to make an agent forget. The replacement session re-opens the same
	// transcript truncated at the rewind point, so the agent keeps everything
	// that came *before* — the point of doing this via --resume rather than a
	// cold restart.
	//
	// Waits for each stopped session's workspace snapshot: that snapshot is what
	// the replacement restores the transcript from, and it is only written after
	// the container exits.
	await stopConversationSessions(db, sessionManager, id, { awaitSnapshot: true })

	const resumeByAgent = new Map(
		resumeTargets.map((t) => [
			t.agentId,
			{ cliSessionId: t.cliSessionId, turnOrdinal: t.turnOrdinal, sessionId: t.sessionId },
		]),
	)
	logger.info('Conversation rewound', {
		conversationId: id,
		branchId: branch.id,
		rewoundToMessageId: messageId,
		// An agent absent here restarts cold: correct, but it re-reads a short
		// history blob instead of its real transcript. Worth noticing if it is
		// happening on every rewind rather than occasionally.
		resumableAgents: resumeTargets.length,
	})

	evaluateAndRespond({
		db,
		sessionManager,
		workspaceId,
		conversationId: id,
		messageId: created.id,
		options: { forceRespond: true, resumeByAgent },
	}).catch((err: unknown) =>
		logger.error('Conversation responder failed after rewind', {
			conversationId: id,
			messageId: created.id,
			error: String(err),
		}),
	)

	const [caller] = await db
		.select({ name: actors.name, type: actors.type })
		.from(actors)
		.where(eq(actors.id, callerId))
		.limit(1)

	return c.json(
		{
			branch_id: branch.id,
			message: serialize({
				...created,
				actorName: caller?.name ?? 'Unknown',
				actorType: caller?.type ?? 'human',
			}) as z.infer<typeof messageResponseSchema>,
		},
		202,
	)
}) as RouteHandler<typeof rewindMessageRoute, Env>)

// POST /:id/branch - Switch which branch of the conversation is live
const switchBranchRoute = createRoute({
	method: 'post',
	path: '/{id}/branch',
	tags: ['Conversations'],
	summary: 'Switch the conversation to a different branch',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					// null switches back to the root branch — the conversation as it
					// was before anyone rewound it.
					schema: z.object({ branch_id: z.string().uuid().nullable() }),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': { schema: z.object({ branch_id: z.string().uuid().nullable() }) },
			},
			description: 'Branch switched',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(switchBranchRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const { branch_id: branchId } = c.req.valid('json')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}
	if (row.conversation.activeBranchId === branchId) {
		return c.json({ branch_id: branchId }, 200)
	}

	// Scoped to this conversation, so a branch id belonging to another
	// conversation can't be used to graft an unrelated thread onto this one.
	if (branchId) {
		const [branch] = await db
			.select({ id: conversationBranches.id })
			.from(conversationBranches)
			.where(
				and(eq(conversationBranches.id, branchId), eq(conversationBranches.conversationId, id)),
			)
			.limit(1)
		if (!branch) {
			return c.json(createApiError('NOT_FOUND', 'Branch not found'), 404)
		}
	}

	await db
		.update(conversations)
		.set({ activeBranchId: branchId, updatedAt: new Date() })
		.where(eq(conversations.id, id))

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'conversation_branch_switched',
		entityType: 'conversation',
		entityId: id,
		data: { branch_id: branchId, previous_branch_id: row.conversation.activeBranchId },
	})

	// Same reason as rewind: a live session's context belongs to the branch it
	// was seeded on, so it must not keep answering on a different one.
	await stopConversationSessions(db, sessionManager, id)

	return c.json({ branch_id: branchId }, 200)
}) as RouteHandler<typeof switchBranchRoute, Env>)

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

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'conversation_participant_state_updated',
		entityType: 'conversation',
		entityId: id,
		data: {
			pinned: body.pinned,
			archived: body.archived,
			last_read_message_id: body.last_read_message_id,
		},
	})

	return c.json({
		pinned: updated.pinned,
		archived: updated.archived,
		last_read_message_id: updated.lastReadMessageId ?? null,
	} as z.infer<typeof conversationParticipantStateResponseSchema>)
}) as RouteHandler<typeof updateMeRoute, Env>)

export default app
