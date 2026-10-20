import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	installedLoops,
	messageReactions,
	messageThreadReads,
	messages,
	objects,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	addConversationParticipantsSchema,
	addReactionSchema,
	conversationListQuerySchema,
	createConversationSchema,
	editMessageSchema,
	markThreadReadSchema,
	messageQuerySchema,
	postMessageSchema,
	removeReactionQuerySchema,
	stripServerOwnedMetadata,
	threadListQuerySchema,
	updateConversationParticipantStateSchema,
	updateConversationSchema,
} from '@maskin/shared'
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { createApiError, formatZodError } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { refuseRawSecret } from '../lib/integrations/raw-secret-backstop'
import { logger } from '../lib/logger'
import {
	conversationDetailResponseSchema,
	conversationListItemResponseSchema,
	conversationParticipantStateResponseSchema,
	errorSchema,
	idParamSchema,
	messageResponseSchema,
	messageWithSpawnedSessionsSchema,
	postMessageResponseSchema,
	spawnedSessionResponseSchema,
	threadListItemSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'
import { insertConversationMessage, mirrorAsObjectComment } from '../services/conversation-messages'
import { evaluateAndRespond } from '../services/conversation-responder'
import { maybeGenerateConversationTitle } from '../services/conversation-titler'
import { loadReactionsByMessage } from '../services/message-reactions'
import { listCallerThreadRootIds, loadThreadSummaries } from '../services/message-threads'
import { importObjectComments } from '../services/object-chat-sync'
import type { SessionManager } from '../services/session-manager'
import {
	anchorSpawnedSessionsToMessage,
	loadPendingSpawnedSessions,
	loadSpawnedSessionsByMessage,
} from '../services/spawned-sessions'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: SessionManager
		maskinSessionId?: string
		workspaceRole?: string
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

/** Column set behind every message response, joined to its author's name and type. */
const messageColumns = {
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
	threadRootId: messages.threadRootId,
	threadAlsoInChannel: messages.threadAlsoInChannel,
}

// The chat that already exists for a subject, if any.
async function findSubjectConversation(
	db: Database,
	workspaceId: string,
	subject: { type: 'object' | 'loop'; id: string },
) {
	const [row] = await db
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.workspaceId, workspaceId),
				eq(conversations.subjectType, subject.type),
				eq(conversations.subjectId, subject.id),
			),
		)
		.limit(1)
	return row
}

// Asking for a subject's chat again puts the asker (and anyone they named) in
// it: new people are added, people who left come back.
async function joinSubjectConversation(
	db: Database,
	conversation: typeof conversations.$inferSelect,
	participantIds: string[],
	callerId: string,
) {
	await db
		.insert(conversationParticipants)
		.values(
			participantIds.map((actorId) => ({
				conversationId: conversation.id,
				actorId,
				addedBy: callerId,
			})),
		)
		.onConflictDoUpdate({
			target: [conversationParticipants.conversationId, conversationParticipants.actorId],
			set: { leftAt: null, updatedAt: new Date() },
		})
	await recordEvent(db, {
		workspaceId: conversation.workspaceId,
		actorId: callerId,
		action: 'conversation_participant_added',
		entityType: 'conversation',
		entityId: conversation.id,
		data: { added_actor_ids: participantIds },
	})
	const [mine] = await db
		.select()
		.from(conversationParticipants)
		.where(
			and(
				eq(conversationParticipants.conversationId, conversation.id),
				eq(conversationParticipants.actorId, callerId),
			),
		)
	const participants = await loadParticipantsByConversation(db, [conversation.id])
	return {
		...serialize(conversation),
		pinned: mine?.pinned ?? false,
		archived: mine?.archived ?? false,
		unread_count: 0,
		last_read_message_id: mine?.lastReadMessageId ?? null,
		participants: participants.get(conversation.id) ?? [],
	} as z.infer<typeof conversationDetailResponseSchema>
}

// POST / - Create conversation
const createConversationRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['Conversations'],
	summary: 'Create a conversation with one or more human/agent participants',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: createConversationSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: conversationDetailResponseSchema } },
			description: 'The existing chat for this subject; new participants were added to it',
		},
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	if (body.initial_message) {
		const secretRefusal = await refuseRawSecret(db, {
			content: body.initial_message,
			workspaceId,
			actorId: callerId,
			actorType: c.get('actorType'),
			entityType: 'workspace',
			entityId: workspaceId,
		})
		if (secretRefusal) return c.json(secretRefusal, 400)
	}

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

	if (body.subject) {
		const { type, id } = body.subject
		const [target] =
			type === 'object'
				? await db
						.select({ id: objects.id })
						.from(objects)
						.where(and(eq(objects.id, id), eq(objects.workspaceId, workspaceId)))
						.limit(1)
				: await db
						.select({ id: installedLoops.id })
						.from(installedLoops)
						.where(and(eq(installedLoops.id, id), eq(installedLoops.workspaceId, workspaceId)))
						.limit(1)
		if (!target) {
			return c.json(
				createApiError('BAD_REQUEST', 'The subject was not found in this workspace', [
					{ field: 'subject', message: `No ${type} with id ${id}` },
				]),
				400,
			)
		}

		const existing = await findSubjectConversation(db, workspaceId, body.subject)
		if (existing)
			return c.json(await joinSubjectConversation(db, existing, participantIds, callerId), 200)
	}

	let txResult: Awaited<ReturnType<typeof createInTransaction>>
	try {
		txResult = await createInTransaction()
	} catch (err) {
		// Two people opened the same subject at once; the unique index let one
		// win. Join the winner's chat instead of failing.
		const existing = body.subject
			? await findSubjectConversation(db, workspaceId, body.subject)
			: undefined
		if (!existing) throw err
		return c.json(await joinSubjectConversation(db, existing, participantIds, callerId), 200)
	}
	const { conversation, initialMessage } = txResult
	if (body.subject?.type === 'object') {
		await importObjectComments(db, {
			conversationId: conversation.id,
			workspaceId,
			objectId: body.subject.id,
			actorId: callerId,
		})
	}

	async function createInTransaction() {
		return db.transaction(async (tx) => {
			const [created] = await tx
				.insert(conversations)
				.values({
					workspaceId,
					title: body.title,
					createdBy: callerId,
					subjectType: body.subject?.type ?? null,
					subjectId: body.subject?.id ?? null,
				})
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

			await recordEvent(tx, {
				workspaceId,
				actorId: callerId,
				action: 'conversation_created',
				entityType: 'conversation',
				entityId: created.id,
				data: {
					participant_actor_ids: participantIds,
					...(body.subject ? { subject: body.subject } : {}),
				},
			})

			return { conversation: created, initialMessage }
		})
	}

	if (initialMessage) {
		await mirrorAsObjectComment(db, {
			conversationId: conversation.id,
			workspaceId,
			actorId: callerId,
			content: initialMessage.content,
			mentions: body.initial_message_metadata?.mentions,
			messageId: initialMessage.id,
		})
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
	if (query.subject_type) conditions.push(eq(conversations.subjectType, query.subject_type))
	if (query.subject_id) conditions.push(eq(conversations.subjectId, query.subject_id))
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
				// The sender comes back with the preview so the row can say who is
				// talking. Left-joined: a message from an actor that has since been
				// deleted still yields its text rather than dropping the snippet.
				const [latest] = await db
					.select({
						content: messages.content,
						actorId: messages.actorId,
						actorName: actors.name,
					})
					.from(messages)
					.leftJoin(actors, eq(actors.id, messages.actorId))
					.where(eq(messages.conversationId, r.conversation.id))
					.orderBy(desc(messages.id))
					.limit(1)
				return {
					conversationId: r.conversation.id,
					snippet: latest?.content ?? null,
					snippetActorId: latest?.actorId ?? null,
					snippetActorName: latest?.actorName ?? null,
				}
			}),
		),
	])

	const unreadByConversation = new Map(unreadRows.map((r) => [r.conversationId, r.unreadCount]))
	const snippetByConversation = new Map(snippets.map((s) => [s.conversationId, s]))

	return c.json({
		conversations: page.map((r) => ({
			...serialize(r.conversation),
			pinned: r.participant.pinned,
			archived: r.participant.archived,
			unread_count: unreadByConversation.get(r.conversation.id) ?? 0,
			snippet: snippetByConversation.get(r.conversation.id)?.snippet ?? null,
			snippet_actor_id: snippetByConversation.get(r.conversation.id)?.snippetActorId ?? null,
			snippet_actor_name: snippetByConversation.get(r.conversation.id)?.snippetActorName ?? null,
			participants: participantsByConversation.get(r.conversation.id) ?? [],
		})) as z.infer<typeof conversationListItemResponseSchema>[],
		has_more: hasMore,
	})
}) as RouteHandler<typeof listConversationsRoute, Env>)

// GET /threads - Threads the caller is in, across their conversations
const listThreadsRoute = createRoute({
	method: 'get',
	path: '/threads',
	tags: ['Conversations'],
	summary: 'List threads the caller started or replied in, most recently active first',
	request: { headers: workspaceIdHeader, query: threadListQuerySchema },
	responses: {
		200: {
			content: {
				'application/json': { schema: z.object({ threads: z.array(threadListItemSchema) }) },
			},
			description: 'Threads',
		},
	},
})

app.openapi(listThreadsRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { limit } = c.req.valid('query')

	const rootIds = await listCallerThreadRootIds(db, { callerId, workspaceId, limit })
	if (rootIds.length === 0) return c.json({ threads: [] })

	const roots = await db
		.select({ ...messageColumns, conversationTitle: conversations.title })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(inArray(messages.id, rootIds))
	const summaries = await loadThreadSummaries(db, callerId, roots)

	const lastReplyIds = [...summaries.values()].map((s) => s.lastReplyId)
	const lastReplies =
		lastReplyIds.length === 0
			? []
			: await db
					.select(messageColumns)
					.from(messages)
					.innerJoin(actors, eq(actors.id, messages.actorId))
					.where(inArray(messages.id, lastReplyIds))
	const replyById = new Map(lastReplies.map((m) => [m.id, m]))
	const rootById = new Map(roots.map((r) => [r.id, r]))

	return c.json({
		threads: rootIds.flatMap((id) => {
			const root = rootById.get(id)
			const thread = summaries.get(id)
			if (!root || !thread) return []
			const { conversationTitle, ...rootMessage } = root
			const reply = replyById.get(thread.lastReplyId)
			return [
				{
					conversationId: root.conversationId,
					conversationTitle,
					root: serialize(rootMessage),
					thread,
					lastReply: reply ? serialize(reply) : null,
				},
			]
		}),
	}) as never
}) as RouteHandler<typeof listThreadsRoute, Env>)

// PUT /:id/messages/:messageId/thread/read - Advance the caller's thread read cursor
const markThreadReadRoute = createRoute({
	method: 'put',
	path: '/{id}/messages/{messageId}/thread/read',
	tags: ['Conversations'],
	summary: 'Mark a thread read up to a reply (advance-only)',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid(), messageId: z.coerce.number().int().positive() }),
		body: { content: { 'application/json': { schema: markThreadReadSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ last_read_message_id: z.number() }) } },
			description: 'Cursor after the update',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(markThreadReadRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, messageId } = c.req.valid('param')
	const { last_read_message_id: lastRead } = c.req.valid('json')

	const row = await loadConversationWithAuth(db, id, callerId)
	if (!row || row.conversation.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}
	const [root] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.conversationId, id),
				isNull(messages.threadRootId),
			),
		)
		.limit(1)
	if (!root) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	const [cursor] = await db
		.insert(messageThreadReads)
		.values({ actorId: callerId, rootMessageId: messageId, lastReadMessageId: lastRead })
		.onConflictDoUpdate({
			target: [messageThreadReads.actorId, messageThreadReads.rootMessageId],
			set: {
				lastReadMessageId: sql`GREATEST(${messageThreadReads.lastReadMessageId}, ${lastRead})`,
				updatedAt: new Date(),
			},
		})
		.returning({ lastReadMessageId: messageThreadReads.lastReadMessageId })
	return c.json({ last_read_message_id: cursor?.lastReadMessageId ?? lastRead }, 200)
}) as RouteHandler<typeof markThreadReadRoute, Env>)

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
	'x-viewer-policy': 'writer',
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
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

	await recordEvent(db, {
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
	'x-viewer-policy': 'writer',
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
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

	await recordEvent(db, {
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
	'x-viewer-policy': 'writer',
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
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
		await recordEvent(db, {
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
						messages: z.array(messageWithSpawnedSessionsSchema),
						has_more: z.boolean(),
						pending_handoffs: z.array(spawnedSessionResponseSchema).optional(),
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
	if (query.thread_root_id) conditions.push(eq(messages.threadRootId, query.thread_root_id))

	const rows = await db
		.select(messageColumns)
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(and(...conditions))
		.orderBy(desc(messages.id))
		.limit(query.limit + 1)

	const hasMore = rows.length > query.limit
	const page = rows.slice(0, query.limit)

	// Participant-scoped delegation strip. `loadSpawnedSessionsByMessage` returns
	// empty buckets for a caller who is not a participant, so a non-member sees the
	// message list with no sub-agent prompts attached.
	const spawned = await loadSpawnedSessionsByMessage(db, {
		conversationId: id,
		workspaceId,
		messageIds: page.map((m) => m.id),
		actorId: callerId,
	})

	const reactions = await loadReactionsByMessage(
		db,
		callerId,
		page.map((m) => m.id),
	)

	const summaries = await loadThreadSummaries(
		db,
		callerId,
		page.filter((m) => m.threadRootId === null),
	)

	// Handoffs no message carries yet ride on the newest page only.
	const pendingHandoffs = query.before_id
		? undefined
		: await loadPendingSpawnedSessions(db, {
				conversationId: id,
				workspaceId,
				actorId: callerId,
			})

	return c.json({
		messages: page.map(
			(m) =>
				({
					...serialize(m),
					spawned_sessions: spawned.get(m.id) ?? [],
					reactions: reactions.get(m.id) ?? [],
					thread: summaries.get(m.id) ?? null,
				}) as z.infer<typeof messageWithSpawnedSessionsSchema>,
		),
		has_more: hasMore,
		...(pendingHandoffs ? { pending_handoffs: pendingHandoffs } : {}),
	})
}) as RouteHandler<typeof listMessagesRoute, Env>)

// POST /:id/messages - Post a message
const postMessageRoute = createRoute({
	method: 'post',
	path: '/{id}/messages',
	'x-viewer-policy': 'writer',
	tags: ['Conversations'],
	summary: 'Post a message to a conversation',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: postMessageSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: postMessageResponseSchema } },
			description: 'Message posted',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Body contains a raw secret (RAW_SECRET_DETECTED)',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(postMessageRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
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

	// Keychain backstop; see refuseRawSecret.
	const secretRefusal = await refuseRawSecret(db, {
		content: body.content,
		workspaceId,
		actorId: callerId,
		actorType: callerType,
		entityType: 'conversation',
		entityId: id,
	})
	if (secretRefusal) return c.json(secretRefusal, 400)

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

	// A thread reply must hang off a top-level message of this same conversation:
	// threads are one level deep, so a reply to a reply is rejected rather than
	// silently re-rooted.
	if (body.thread_root_id !== undefined) {
		const [root] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.id, body.thread_root_id),
					eq(messages.conversationId, id),
					isNull(messages.threadRootId),
				),
			)
			.limit(1)
		if (!root) {
			return c.json(createApiError('NOT_FOUND', 'Thread root message not found'), 404)
		}
	}

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
		threadRootId: body.thread_root_id ?? null,
		threadAlsoInChannel: body.thread_root_id !== undefined && body.also_in_channel === true,
	})
	if (!created) throw new Error('Failed to create message')

	// Replying means the human has read everything before their message, so their read cursor
	// moves to it: otherwise the thread keeps a NEW divider (and the list an unread badge) over
	// messages they just answered, on every surface that replied from somewhere the cursor
	// was never reported. Advance-only, like PATCH /:id/me. Humans only: an agent posting
	// mid-turn may not have seen what landed since, and moving its cursor would hide that
	// from its unread list.
	if (callerType === 'human') {
		await db
			.update(conversationParticipants)
			.set({
				lastReadMessageId: sql`GREATEST(COALESCE(${conversationParticipants.lastReadMessageId}, 0), ${created.id})`,
			})
			.where(
				and(
					eq(conversationParticipants.conversationId, id),
					eq(conversationParticipants.actorId, callerId),
				),
			)
		await recordEvent(db, {
			workspaceId,
			actorId: callerId,
			action: 'conversation_participant_state_updated',
			entityType: 'conversation',
			entityId: id,
			data: { last_read_message_id: created.id, via: 'post_message' },
		})
	}

	// An agent narrating a handoff mid-turn: hang the sub-sessions it has started
	// since its last message under this one, so the card shows while they run.
	// The spawner is the agent's own live session, taken from the body or, since
	// the MCP post tool does not send it, the X-Maskin-Session-Id header.
	if (callerType === 'agent') {
		const claimed = sessionId ?? c.get('maskinSessionId')
		if (claimed) {
			const [own] = await db
				.select({ id: sessions.id })
				.from(sessions)
				.where(
					and(
						eq(sessions.id, claimed),
						eq(sessions.actorId, callerId),
						eq(sessions.workspaceId, workspaceId),
					),
				)
				.limit(1)
			if (own) {
				await anchorSpawnedSessionsToMessage(db, {
					spawnerSessionId: own.id,
					conversationId: id,
					actorId: callerId,
					messageId: created.id,
				})
			}
		}
	}

	// @mentioning an agent who isn't yet an active participant should actually
	// pull them into the conversation — otherwise evaluateAndRespond's
	// candidate query (scoped to active conversationParticipants) never sees
	// them and the mention silently does nothing. Auto-join here, before
	// evaluateAndRespond runs, so the freshly-mentioned agent is already a
	// candidate for this very message.
	const mentionedIds = metadata?.mentions ?? []
	// Ids that are neither already in the conversation nor workspace members:
	// nothing joins them and nothing wakes them. Reported back so a mistyped
	// UUID doesn't fail silently (same contract as POST /events comments).
	let unresolvedMentions: string[] = []
	if (mentionedIds.length > 0) {
		const activeParticipants = await loadParticipantsByConversation(db, [id])
		const activeIds = new Set((activeParticipants.get(id) ?? []).map((p) => p.actorId))
		const notYetJoined = mentionedIds.filter((actorId) => !activeIds.has(actorId))
		if (notYetJoined.length > 0) {
			const memberIds = await loadWorkspaceMemberIds(db, workspaceId, notYetJoined)
			const toAdd = notYetJoined.filter((actorId) => memberIds.has(actorId))
			unresolvedMentions = Array.from(new Set(notYetJoined.filter((id) => !memberIds.has(id))))
			if (toAdd.length > 0) {
				await addParticipantsToConversation(db, id, toAdd, callerId)
				await recordEvent(db, {
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
			...(unresolvedMentions.length > 0 ? { unresolved_mentions: unresolvedMentions } : {}),
		}) as z.infer<typeof postMessageResponseSchema>,
		201,
	)
}) as RouteHandler<typeof postMessageRoute, Env>)

// PATCH /:id/messages/:messageId - Edit an own message
const editMessageRoute = createRoute({
	method: 'patch',
	path: '/{id}/messages/{messageId}',
	'x-viewer-policy': 'writer',
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
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Edit looks like it contains a secret',
		},
		403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not author' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(editMessageRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
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

	const secretRefusal = await refuseRawSecret(db, {
		content: body.content,
		workspaceId,
		actorId: callerId,
		actorType: c.get('actorType'),
		entityType: 'conversation',
		entityId: id,
	})
	if (secretRefusal) return c.json(secretRefusal, 400)

	const editedAt = new Date()
	const [updated] = await db
		.update(messages)
		.set({ content: body.content, editedAt })
		.where(eq(messages.id, messageId))
		.returning()
	if (!updated) throw new Error('Failed to update message')

	await recordEvent(db, {
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
		.where(and(eq(messages.conversationId, id), eq(messages.kind, 'message')))
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

// PUT /:id/messages/:messageId/reactions - React with an emoji (idempotent)
const addReactionRoute = createRoute({
	method: 'put',
	path: '/{id}/messages/{messageId}/reactions',
	'x-viewer-policy': 'writer',
	tags: ['Conversations'],
	summary: 'React to a message with an emoji',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid(), messageId: z.coerce.number().int().positive() }),
		body: { content: { 'application/json': { schema: addReactionSchema } } },
	},
	responses: {
		204: { description: 'Reaction recorded' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

// DELETE /:id/messages/:messageId/reactions?emoji= - Take your reaction back
const removeReactionRoute = createRoute({
	method: 'delete',
	path: '/{id}/messages/{messageId}/reactions',
	'x-viewer-policy': 'writer',
	tags: ['Conversations'],
	summary: 'Remove your emoji reaction from a message',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid(), messageId: z.coerce.number().int().positive() }),
		query: removeReactionQuerySchema,
	},
	responses: {
		204: { description: 'Reaction removed (or was not there)' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

/** The message must be a real (non-system) message of a conversation the caller is in. */
async function findReactableMessage(
	db: Database,
	args: { conversationId: string; messageId: number; callerId: string; workspaceId: string },
): Promise<boolean> {
	const row = await loadConversationWithAuth(db, args.conversationId, args.callerId)
	if (!row || row.conversation.workspaceId !== args.workspaceId) return false
	const [message] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.id, args.messageId),
				eq(messages.conversationId, args.conversationId),
				eq(messages.kind, 'message'),
			),
		)
		.limit(1)
	return Boolean(message)
}

app.openapi(addReactionRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, messageId } = c.req.valid('param')
	const { emoji } = c.req.valid('json')

	if (!(await findReactableMessage(db, { conversationId: id, messageId, callerId, workspaceId }))) {
		return c.json(createApiError('NOT_FOUND', 'Message not found'), 404)
	}
	const inserted = await db
		.insert(messageReactions)
		.values({ messageId, actorId: callerId, emoji })
		.onConflictDoNothing()
		.returning({ messageId: messageReactions.messageId })
	// Only a change is an event: repeating a reaction must not wake every open chat.
	if (inserted.length > 0) {
		// `message_updated` makes open clients re-read the page, which carries the reactions.
		await recordEvent(db, {
			workspaceId,
			actorId: callerId,
			action: 'message_updated',
			entityType: 'conversation',
			entityId: id,
			data: { message_id: messageId, reaction: { emoji, added: true } },
		})
	}
	return c.body(null, 204)
}) as RouteHandler<typeof addReactionRoute, Env>)

app.openapi(removeReactionRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, messageId } = c.req.valid('param')
	const { emoji } = c.req.valid('query')

	if (!(await findReactableMessage(db, { conversationId: id, messageId, callerId, workspaceId }))) {
		return c.json(createApiError('NOT_FOUND', 'Message not found'), 404)
	}
	const removed = await db
		.delete(messageReactions)
		.where(
			and(
				eq(messageReactions.messageId, messageId),
				eq(messageReactions.actorId, callerId),
				eq(messageReactions.emoji, emoji),
			),
		)
		.returning({ messageId: messageReactions.messageId })
	if (removed.length > 0) {
		await recordEvent(db, {
			workspaceId,
			actorId: callerId,
			action: 'message_updated',
			entityType: 'conversation',
			entityId: id,
			data: { message_id: messageId, reaction: { emoji, added: false } },
		})
	}
	return c.body(null, 204)
}) as RouteHandler<typeof removeReactionRoute, Env>)

// POST /:id/messages/:messageId/retry - Ask agents to respond to a message again
const retryMessageRoute = createRoute({
	method: 'post',
	path: '/{id}/messages/{messageId}/retry',
	'x-viewer-policy': 'writer',
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
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
	// mark_unread is a reset, so it must bypass the GREATEST guard below — that
	// guard is advance-only by design and would clamp any reset straight back up
	// to the existing cursor, turning the write into a silent no-op. Null is the
	// stored "never read" value (a fresh participant row starts at null and every
	// read query coalesces it to 0), so the reset is a direct assignment.
	if (body.mark_unread === true) {
		setValues.lastReadMessageId = null
	} else if (body.last_read_message_id !== undefined) {
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

	await recordEvent(db, {
		workspaceId,
		actorId: callerId,
		action: 'conversation_participant_state_updated',
		entityType: 'conversation',
		entityId: id,
		data: {
			pinned: body.pinned,
			archived: body.archived,
			last_read_message_id: body.last_read_message_id,
			mark_unread: body.mark_unread,
		},
	})

	return c.json({
		pinned: updated.pinned,
		archived: updated.archived,
		last_read_message_id: updated.lastReadMessageId ?? null,
	} as z.infer<typeof conversationParticipantStateResponseSchema>)
}) as RouteHandler<typeof updateMeRoute, Env>)

export default app
