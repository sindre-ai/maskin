import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	type Thread,
	actors,
	sessions,
	threadEvents,
	threadParticipants,
	threads,
} from '@maskin/db/schema'
import type { PgNotifyBridge, PgThreadEvent } from '@maskin/realtime'
import {
	addThreadParticipantSchema,
	createThreadEventSchema,
	createThreadSchema,
	threadEventQuerySchema,
	threadParamsSchema,
	threadParticipantParamsSchema,
	threadQuerySchema,
	updateThreadSchema,
} from '@maskin/shared'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, jsonbField, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'
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

// ── Response Schemas ─────────────────────────────────────────────────────────

const participantResponseSchema = z.object({
	actorId: z.string().uuid(),
	kind: z.string(),
	joinedAt: z.string(),
})

const threadEventResponseSchema = z.object({
	id: z.string().uuid(),
	threadId: z.string().uuid(),
	actorId: z.string().uuid(),
	kind: z.string(),
	body: z.string().nullable(),
	metadata: jsonbField,
	createdAt: z.string().nullable(),
})

const threadResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	focusObjectId: z.string().uuid().nullable(),
	visibility: z.string(),
	state: z.string(),
	kind: z.string(),
	title: z.string(),
	participants: z.array(participantResponseSchema),
	resolvedAt: z.string().nullable(),
	resolvedBy: z.string().uuid().nullable(),
	resolution: z.string().nullable(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load a thread and verify it belongs to the caller's workspace.
 * Returns null if not found or workspace mismatch.
 */
async function loadThread(db: Database, threadId: string, workspaceId: string) {
	const [thread] = await db
		.select()
		.from(threads)
		.where(and(eq(threads.id, threadId), eq(threads.workspaceId, workspaceId)))
		.limit(1)
	return thread ?? null
}

/** Fetch all participants for a thread, returning serializable shape. */
async function loadParticipants(db: Database, threadId: string) {
	const rows = await db
		.select()
		.from(threadParticipants)
		.where(eq(threadParticipants.threadId, threadId))
		.orderBy(asc(threadParticipants.joinedAt))

	return rows.map((p) => ({
		actorId: p.actorId,
		kind: p.kind,
		joinedAt: p.joinedAt instanceof Date ? p.joinedAt.toISOString() : String(p.joinedAt),
	}))
}

/** Check if an actor is a participant in a thread. */
async function isThreadParticipant(
	db: Database,
	threadId: string,
	actorId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ actorId: threadParticipants.actorId })
		.from(threadParticipants)
		.where(and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.actorId, actorId)))
		.limit(1)
	return !!row
}

// ── POST / — Create thread ────────────────────────────────────────────────────

const createThreadRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Threads'],
	summary: 'Create a thread',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: createThreadSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: threadResponseSchema } },
			description: 'Thread created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(createThreadRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const actorType = c.get('actorType')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const { thread, participants } = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(threads)
			.values({
				workspaceId,
				focusObjectId: body.focus_object_id,
				visibility: body.visibility,
				kind: body.kind,
				title: body.title,
				createdBy: actorId,
			})
			.returning()

		if (!created) throw new Error('Failed to create thread')

		// Auto-add creator as participant
		const additionalIds = (body.participant_ids ?? []).filter((id) => id !== actorId)
		const participantInserts = [
			{ threadId: created.id, actorId, kind: actorType === 'agent' ? 'agent' : 'human' },
			...additionalIds.map((id) => ({
				threadId: created.id,
				actorId: id,
				kind: 'human' as const, // default; caller can update via add-participant if needed
			})),
		]

		const createdParticipants = await tx
			.insert(threadParticipants)
			.values(participantInserts)
			.onConflictDoNothing()
			.returning()

		// Log join events for all participants
		if (createdParticipants.length > 0) {
			await tx.insert(threadEvents).values(
				createdParticipants.map((p) => ({
					threadId: created.id,
					actorId: p.actorId,
					kind: 'join',
				})),
			)
		}

		// Log workspace event for the activity feed
		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'thread',
			entityId: created.id,
			data: { title: created.title, visibility: created.visibility },
		})

		const parts = await tx
			.select()
			.from(threadParticipants)
			.where(eq(threadParticipants.threadId, created.id))

		return { thread: created, participants: parts }
	})

	const serialized = serialize(thread)
	const serializedParticipants = participants.map((p) => ({
		actorId: p.actorId,
		kind: p.kind,
		joinedAt: p.joinedAt instanceof Date ? p.joinedAt.toISOString() : String(p.joinedAt),
	}))

	return c.json(
		{ ...serialized, participants: serializedParticipants } as z.infer<typeof threadResponseSchema>,
		201,
	)
}) as RouteHandler<typeof createThreadRoute, Env>)

// ── GET / — List threads ──────────────────────────────────────────────────────

const listThreadsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Threads'],
	summary: 'List threads',
	request: {
		headers: workspaceIdHeader,
		query: threadQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(threadResponseSchema) } },
			description: 'List of threads',
		},
	},
})

app.openapi(listThreadsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const conditions = [eq(threads.workspaceId, workspaceId)]
	if (query.state) conditions.push(eq(threads.state, query.state))
	if (query.focus_object_id) conditions.push(eq(threads.focusObjectId, query.focus_object_id))

	// Visibility filter: private threads only visible to participants
	if (query.visibility === 'private') {
		conditions.push(eq(threads.visibility, 'private'))
	} else if (query.visibility === 'channel') {
		conditions.push(eq(threads.visibility, 'channel'))
	}

	const rawLimit = query.limit
	const rawOffset = query.offset
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50
	const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

	const rows = await db
		.select()
		.from(threads)
		.where(and(...conditions))
		.orderBy(desc(threads.updatedAt))
		.limit(limit)
		.offset(offset)

	// Filter private threads to only ones the actor participates in
	let filtered = rows
	const privateThreadIds = rows.filter((t) => t.visibility === 'private').map((t) => t.id)
	if (privateThreadIds.length > 0) {
		const participatingRows = await db
			.select({ threadId: threadParticipants.threadId })
			.from(threadParticipants)
			.where(
				and(
					inArray(threadParticipants.threadId, privateThreadIds),
					eq(threadParticipants.actorId, actorId),
				),
			)
		const participatingIds = new Set(participatingRows.map((r) => r.threadId))
		filtered = rows.filter((t) => t.visibility === 'channel' || participatingIds.has(t.id))
	}

	// Load participants for all threads
	const allThreadIds = (filtered as Thread[]).map((t) => t.id)
	let allParticipants: Array<{
		threadId: string
		actorId: string
		kind: string
		joinedAt: Date | null
	}> = []
	if (allThreadIds.length > 0) {
		allParticipants = await db
			.select()
			.from(threadParticipants)
			.where(inArray(threadParticipants.threadId, allThreadIds))
	}

	const participantsByThread = new Map<string, typeof allParticipants>()
	for (const p of allParticipants) {
		const list = participantsByThread.get(p.threadId) ?? []
		list.push(p)
		participantsByThread.set(p.threadId, list)
	}

	const result = (filtered as Thread[]).map((t) => {
		const parts = (participantsByThread.get(t.id) ?? []).map((p) => ({
			actorId: p.actorId,
			kind: p.kind,
			joinedAt: p.joinedAt instanceof Date ? p.joinedAt.toISOString() : String(p.joinedAt),
		}))
		return { ...serialize(t), participants: parts }
	})

	return c.json(result as z.infer<typeof threadResponseSchema>[])
}) as RouteHandler<typeof listThreadsRoute, Env>)

// ── GET /:id — Get thread ─────────────────────────────────────────────────────

const getThreadRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Threads'],
	summary: 'Get a thread with events and participants',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: threadResponseSchema.extend({
						events: z.array(threadEventResponseSchema),
					}),
				},
			},
			description: 'Thread details',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Access denied',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Thread not found',
		},
	},
})

app.openapi(getThreadRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const thread = await loadThread(db, id, workspaceId)
	if (!thread) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	// Private threads: only participants can view
	if (thread.visibility === 'private') {
		const isMember = await isThreadParticipant(db, id, actorId)
		if (!isMember) return c.json(createApiError('FORBIDDEN', 'Access denied'), 403)
	}

	const [participants, threadEventsRows] = await Promise.all([
		loadParticipants(db, id),
		db
			.select()
			.from(threadEvents)
			.where(eq(threadEvents.threadId, id))
			.orderBy(asc(threadEvents.createdAt))
			.limit(200),
	])

	return c.json({
		...serialize(thread),
		participants,
		events: serializeArray(threadEventsRows),
	} as z.infer<(typeof getThreadRoute.responses)[200]['content']['application/json']['schema']>)
}) as RouteHandler<typeof getThreadRoute, Env>)

// ── POST /:id/events — Append event ──────────────────────────────────────────

const appendEventRoute = createRoute({
	method: 'post',
	path: '/{id}/events',
	tags: ['Threads'],
	summary: 'Append an event to a thread',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: createThreadEventSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: threadEventResponseSchema } },
			description: 'Event appended',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a participant',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Thread not found',
		},
	},
})

app.openapi(appendEventRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const thread = await loadThread(db, id, workspaceId)
	if (!thread) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	// Only participants can post events
	const isMember = await isThreadParticipant(db, id, actorId)
	if (!isMember) {
		return c.json(createApiError('FORBIDDEN', 'Only thread participants can post events'), 403)
	}

	const [created] = await db
		.insert(threadEvents)
		.values({
			threadId: id,
			actorId,
			kind: body.kind,
			body: body.body,
			metadata: body.metadata,
		})
		.returning()

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create thread event'), 500)
	}

	// Handle state transitions for special event kinds
	if (body.kind === 'resolve') {
		await db
			.update(threads)
			.set({
				state: 'resolved',
				resolvedAt: new Date(),
				resolvedBy: actorId,
				resolution: body.body ?? null,
				updatedAt: new Date(),
			})
			.where(eq(threads.id, id))

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'resolved',
			entityType: 'thread',
			entityId: id,
			data: { resolution: body.body },
		})
	} else if (body.kind === 'archive') {
		await db
			.update(threads)
			.set({ state: 'archived', updatedAt: new Date() })
			.where(eq(threads.id, id))

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'archived',
			entityType: 'thread',
			entityId: id,
			data: null,
		})
	} else if (body.kind === 'yield') {
		// Agent signals it needs human input — transition thread to waiting
		await db
			.update(threads)
			.set({ state: 'waiting', updatedAt: new Date() })
			.where(eq(threads.id, id))

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'waiting',
			entityType: 'thread',
			entityId: id,
			data: null,
		})
	} else if (body.kind === 'message' && thread.state === 'waiting') {
		// Human replied to a waiting thread — resume active interactive sessions linked to this thread
		await db.update(threads).set({ state: 'open', updatedAt: new Date() }).where(eq(threads.id, id))

		const activeSessions = await db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.threadId, id),
					eq(sessions.interactive, true),
					eq(sessions.status, 'running'),
				),
			)

		for (const session of activeSessions) {
			sessionManager
				.writeInput(session.id, {
					type: 'user',
					message: { role: 'user', content: body.body ?? '' },
				})
				.catch((err) =>
					logger.error('Failed to write input to thread-linked session', {
						sessionId: session.id,
						threadId: id,
						error: String(err),
					}),
				)
		}
	} else {
		// Touch updatedAt so list order reflects latest activity
		await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, id))
	}

	// Fire-and-forget: spawn agent sessions for @mentioned agents
	// Follows the same pattern as comment mentions in apps/dev/src/routes/events.ts
	if (body.mentions?.length) {
		void spawnMentionedAgents({
			db,
			sessionManager,
			workspaceId,
			threadId: id,
			thread,
			mentionerActorId: actorId,
			messageBody: body.body ?? '',
			mentionIds: body.mentions,
		})
	}

	return c.json(serialize(created) as z.infer<typeof threadEventResponseSchema>, 201)
}) as RouteHandler<typeof appendEventRoute, Env>)

/**
 * Spawn interactive agent sessions for each @mentioned agent actor.
 * Skips agents that already have an active session in this thread.
 */
async function spawnMentionedAgents(ctx: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	threadId: string
	thread: Thread
	mentionerActorId: string
	messageBody: string
	mentionIds: string[]
}): Promise<void> {
	const {
		db,
		sessionManager,
		workspaceId,
		threadId,
		thread,
		mentionerActorId,
		messageBody,
		mentionIds,
	} = ctx

	// Look up agent actors from mention IDs
	const mentionedActors = await db
		.select({ id: actors.id, type: actors.type, name: actors.name })
		.from(actors)
		.where(inArray(actors.id, mentionIds))

	const agentActors = mentionedActors.filter((a) => a.type === 'agent')
	if (!agentActors.length) return

	// Verify each agent is a workspace member
	const memberChecks = await Promise.all(
		agentActors.map((agent) => isWorkspaceMember(db, agent.id, workspaceId)),
	)
	const validAgents = agentActors.filter((_, i) => memberChecks[i])
	if (!validAgents.length) return

	// Find agents that already have an active session in this thread
	const existingSessions = await db
		.select({ actorId: sessions.actorId })
		.from(sessions)
		.where(
			and(
				eq(sessions.threadId, threadId),
				inArray(sessions.status, ['pending', 'queued', 'starting', 'running']),
			),
		)
	const activeAgentIds = new Set(existingSessions.map((s) => s.actorId))

	// Fetch recent thread events for context (last 20)
	const recentEvents = await db
		.select()
		.from(threadEvents)
		.where(eq(threadEvents.threadId, threadId))
		.orderBy(desc(threadEvents.createdAt))
		.limit(20)
	recentEvents.reverse()

	for (const agent of validAgents) {
		if (activeAgentIds.has(agent.id)) {
			// Already an active session — deliver as input instead if session is running
			const [runningSession] = await db
				.select()
				.from(sessions)
				.where(
					and(
						eq(sessions.threadId, threadId),
						eq(sessions.actorId, agent.id),
						eq(sessions.status, 'running'),
						eq(sessions.interactive, true),
					),
				)
				.limit(1)
			if (runningSession) {
				sessionManager
					.writeInput(runningSession.id, {
						type: 'user',
						message: { role: 'user', content: messageBody },
					})
					.catch((err) =>
						logger.error('Failed to forward mention to running session', {
							sessionId: runningSession.id,
							agentId: agent.id,
							error: String(err),
						}),
					)
			}
			continue
		}

		// Auto-add agent as thread participant if not already
		await db
			.insert(threadParticipants)
			.values({ threadId, actorId: agent.id, kind: 'agent' })
			.onConflictDoNothing()

		const actionPrompt = buildThreadMentionPrompt({
			thread,
			threadId,
			agentName: agent.name,
			mentionerActorId,
			messageBody,
			recentEvents: recentEvents.map((e) => ({
				actorId: e.actorId,
				kind: e.kind,
				body: e.body ?? '',
			})),
		})

		sessionManager
			.createSession(workspaceId, {
				actorId: agent.id,
				actionPrompt,
				threadId,
				config: { interactive: true },
				createdBy: mentionerActorId,
			})
			.catch((err) =>
				logger.error('Failed to create session for @mentioned agent in thread', {
					agentId: agent.id,
					threadId,
					error: String(err),
				}),
			)
	}
}

function buildThreadMentionPrompt(ctx: {
	thread: Thread
	threadId: string
	agentName: string
	mentionerActorId: string
	messageBody: string
	recentEvents: Array<{ actorId: string; kind: string; body: string }>
}): string {
	const historyLines = ctx.recentEvents.map((e) => `[${e.kind}] ${e.actorId}: ${e.body}`).join('\n')

	return [
		`You were @mentioned in thread "${ctx.thread.title}" (ID: ${ctx.threadId}).`,
		'',
		'## Thread history (most recent)',
		historyLines || '(no prior events)',
		'',
		'## The message that mentioned you',
		`From actor ${ctx.mentionerActorId}:`,
		'"""',
		ctx.messageBody,
		'"""',
		'',
		'## Instructions',
		'- Use the `post_thread_message` MCP tool to reply in this thread.',
		'- Use kind "plan" when describing what you will do next.',
		'- Use kind "yield" when you need human input before continuing.',
		'- Use `resolve_thread` when the thread goal is accomplished.',
		'- This is an interactive session — after posting your response, wait for further messages.',
		`- Thread ID for all tool calls: ${ctx.threadId}`,
	].join('\n')
}

// ── PATCH /:id — Update thread state ─────────────────────────────────────────

const updateThreadRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['Threads'],
	summary: 'Update a thread (state, title, resolution)',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: updateThreadSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: threadResponseSchema } },
			description: 'Thread updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a participant',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Thread not found',
		},
	},
})

app.openapi(updateThreadRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const thread = await loadThread(db, id, workspaceId)
	if (!thread) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	const isMember = await isThreadParticipant(db, id, actorId)
	if (!isMember) {
		return c.json(createApiError('FORBIDDEN', 'Only thread participants can update threads'), 403)
	}

	// Build typed update payload
	const updateData: {
		updatedAt: Date
		title?: string
		state?: string
		resolution?: string | null
		resolvedAt?: Date | null
		resolvedBy?: string | null
	} = { updatedAt: new Date() }

	if (body.title !== undefined) updateData.title = body.title
	if (body.state !== undefined) updateData.state = body.state
	if (body.resolution !== undefined) updateData.resolution = body.resolution

	// If resolving, set resolved metadata
	if (body.state === 'resolved') {
		updateData.resolvedAt = new Date()
		updateData.resolvedBy = actorId
	} else if (body.state === 'open' || body.state === 'waiting') {
		// Reopening — clear resolution metadata
		updateData.resolvedAt = null
		updateData.resolvedBy = null
	}

	const [updated] = await db.update(threads).set(updateData).where(eq(threads.id, id)).returning()

	if (!updated) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	// Log state changes to workspace activity feed
	if (body.state) {
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: body.state,
			entityType: 'thread',
			entityId: id,
			data: { resolution: body.resolution },
		})

		// Create a thread event recording the state change
		let eventKind: string | null = null
		if (body.state === 'resolved') eventKind = 'resolve'
		else if (body.state === 'archived') eventKind = 'archive'

		if (eventKind) {
			await db
				.insert(threadEvents)
				.values({ threadId: id, actorId, kind: eventKind, body: body.resolution })
		}
	}

	const participants = await loadParticipants(db, id)
	return c.json({ ...serialize(updated), participants } as z.infer<typeof threadResponseSchema>)
}) as RouteHandler<typeof updateThreadRoute, Env>)

// ── POST /:id/participants — Add participant ───────────────────────────────────

const addParticipantRoute = createRoute({
	method: 'post',
	path: '/{id}/participants',
	tags: ['Threads'],
	summary: 'Add a participant to a thread',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: addThreadParticipantSchema } } },
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
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Access denied',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Thread not found',
		},
	},
})

app.openapi(addParticipantRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const thread = await loadThread(db, id, workspaceId)
	if (!thread) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	// Workspace member check — caller must be a workspace member
	const memberCheck = await isWorkspaceMember(db, actorId, workspaceId)
	if (!memberCheck) return c.json(createApiError('FORBIDDEN', 'Access denied'), 403)

	const [participant] = await db
		.insert(threadParticipants)
		.values({
			threadId: id,
			actorId: body.actor_id,
			kind: body.kind,
		})
		.onConflictDoNothing()
		.returning()

	// Emit join thread event (if participant was newly inserted)
	if (participant) {
		await db.insert(threadEvents).values({
			threadId: id,
			actorId: body.actor_id,
			kind: 'join',
		})
	}

	// Return the participant regardless (may have already existed)
	const [existing] = await db
		.select()
		.from(threadParticipants)
		.where(and(eq(threadParticipants.threadId, id), eq(threadParticipants.actorId, body.actor_id)))
		.limit(1)

	if (!existing) return c.json(createApiError('INTERNAL_ERROR', 'Failed to add participant'), 500)

	return c.json(
		{
			actorId: existing.actorId,
			kind: existing.kind,
			joinedAt:
				existing.joinedAt instanceof Date
					? existing.joinedAt.toISOString()
					: String(existing.joinedAt),
		} as z.infer<typeof participantResponseSchema>,
		201,
	)
}) as RouteHandler<typeof addParticipantRoute, Env>)

// ── DELETE /:id/participants/:actorId — Remove participant ────────────────────

const removeParticipantRoute = createRoute({
	method: 'delete',
	path: '/{id}/participants/{actorId}',
	tags: ['Threads'],
	summary: 'Remove a participant from a thread',
	request: {
		headers: workspaceIdHeader,
		params: threadParticipantParamsSchema,
	},
	responses: {
		204: {
			description: 'Participant removed',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Access denied',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Thread or participant not found',
		},
	},
})

app.openapi(removeParticipantRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id, actorId: targetActorId } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const thread = await loadThread(db, id, workspaceId)
	if (!thread) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	// Only workspace members can remove participants (self-removal or any for admins)
	const memberCheck = await isWorkspaceMember(db, actorId, workspaceId)
	if (!memberCheck) return c.json(createApiError('FORBIDDEN', 'Access denied'), 403)

	const [removed] = await db
		.delete(threadParticipants)
		.where(and(eq(threadParticipants.threadId, id), eq(threadParticipants.actorId, targetActorId)))
		.returning()

	if (!removed) return c.json(createApiError('NOT_FOUND', 'Participant not found'), 404)

	// Log leave event
	await db.insert(threadEvents).values({
		threadId: id,
		actorId: targetActorId,
		kind: 'leave',
	})

	return new Response(null, { status: 204 })
}) as RouteHandler<typeof removeParticipantRoute, Env>)

// ── GET /:id/events — List events ─────────────────────────────────────────────

const listEventsRoute = createRoute({
	method: 'get',
	path: '/{id}/events',
	tags: ['Threads'],
	summary: 'Get thread events (paginated)',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		query: threadEventQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(threadEventResponseSchema) } },
			description: 'Thread events',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Access denied',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Thread not found',
		},
	},
})

app.openapi(listEventsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const query = c.req.valid('query')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const thread = await loadThread(db, id, workspaceId)
	if (!thread) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	if (thread.visibility === 'private') {
		const isMember = await isThreadParticipant(db, id, actorId)
		if (!isMember) return c.json(createApiError('FORBIDDEN', 'Access denied'), 403)
	}

	const rawLimit = query.limit
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100

	const conditions = [eq(threadEvents.threadId, id)]
	if (query.since) conditions.push(gt(threadEvents.id, query.since))

	const results = await db
		.select()
		.from(threadEvents)
		.where(and(...conditions))
		.orderBy(asc(threadEvents.createdAt))
		.limit(limit)

	return c.json(serializeArray(results) as z.infer<typeof threadEventResponseSchema>[])
}) as RouteHandler<typeof listEventsRoute, Env>)

// ── GET /:id/events/stream — SSE stream ───────────────────────────────────────

app.get('/:id/events/stream', async (c) => {
	const db = c.get('db')
	const bridge = c.get('notifyBridge')
	const rawId = c.req.param('id')
	const workspaceId = c.req.header('x-workspace-id')

	// Validate UUID up front to prevent Postgres errors on malformed ids
	const parsedParams = threadParamsSchema.safeParse({ id: rawId })
	if (!parsedParams.success) {
		return c.json(
			createApiError('BAD_REQUEST', 'Invalid thread id', [
				{ field: 'id', message: 'Must be a UUID', expected: 'UUID string' },
			]),
			400,
		)
	}
	const threadId = parsedParams.data.id

	if (!workspaceId) {
		return c.json(
			createApiError('BAD_REQUEST', 'Missing x-workspace-id header', [
				{ field: 'x-workspace-id', message: 'Required header is missing', expected: 'UUID string' },
			]),
			400,
		)
	}

	const actorId = c.get('actorId')

	const thread = await loadThread(db, threadId, workspaceId)
	if (!thread) return c.json(createApiError('NOT_FOUND', 'Thread not found'), 404)

	// Private threads: only participants can subscribe to the SSE stream
	if (thread.visibility === 'private') {
		const isMember = await isThreadParticipant(db, threadId, actorId)
		if (!isMember) return c.json(createApiError('FORBIDDEN', 'Access denied'), 403)
	}

	return streamSSE(c, async (stream) => {
		const handler = (event: PgThreadEvent) => {
			if (event.thread_id !== threadId) return
			stream
				.writeSSE({
					id: event.id,
					event: event.kind,
					data: JSON.stringify(event),
				})
				.catch((err) => {
					bridge.off('thread_event', handler)
					logger.warn('SSE thread event write failed; detaching listener', {
						err: err instanceof Error ? err.message : String(err),
						threadId,
					})
				})
		}

		bridge.on('thread_event', handler)
		stream.onAbort(() => {
			bridge.off('thread_event', handler)
		})

		// Keep connection alive
		while (true) {
			await stream.sleep(30000)
		}
	})
})

export default app
