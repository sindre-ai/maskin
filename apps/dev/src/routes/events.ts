import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, files, notifications, objects, subscriptions } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { createCommentSchema, eventQuerySchema } from '@maskin/shared'
import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, eventResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serializeArray } from '../lib/serialize'
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

	// Validate any attached file IDs belong to this workspace before we
	// commit them onto the event row. Without this check an attacker could
	// store IDs of files they cannot read, and the renderer would still
	// resolve and link them for any workspace member who can see the comment.
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

	// Collapse reply chains to the thread root. The comment model only supports
	// one level of threading, so a reply to a reply must attach to the root
	// instead — otherwise the UI silently drops the comment (it has nowhere to
	// place a child-of-a-child). Walk up parentEventId until we find a comment
	// with no parent of its own. Each step requires the ancestor to be a
	// `commented` event on the same object; if the chain is broken (parent
	// missing, on a different object, not a comment, or cyclic), drop
	// parentEventId so the comment posts at top level rather than becoming an
	// un-renderable orphan.
	const parentEventId = await resolveRootParentEventId(
		db,
		workspaceId,
		body.entity_id,
		body.parent_event_id,
	)

	const { comment, agentMentions } = await db.transaction(async (tx) => {
		const results = await tx
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
					parentEventId,
					attachmentFileIds: body.attachment_file_ids,
				},
			})
			.returning()

		const created = results[0]
		if (!created) {
			throw new Error('Failed to create comment')
		}

		const mentions: Array<{ agentId: string; notificationId: string }> = []

		// Create notifications for @mentioned agents (batched)
		if (body.mentions?.length) {
			const mentionedActors = await tx
				.select({ id: actors.id, type: actors.type, name: actors.name })
				.from(actors)
				.where(inArray(actors.id, body.mentions))

			const agentActors = mentionedActors.filter((a) => a.type === 'agent')

			if (agentActors.length > 0) {
				const createdNotifications = await tx
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
					await tx.insert(events).values(
						createdNotifications.map((notification) => ({
							workspaceId,
							actorId,
							action: 'created',
							entityType: 'notification',
							entityId: notification.id,
							data: notification,
						})),
					)

					for (const notification of createdNotifications) {
						if (notification.targetActorId) {
							mentions.push({
								agentId: notification.targetActorId,
								notificationId: notification.id,
							})
						}
					}
				}
			}
		}

		// Auto-subscribe the commenter — anyone who comments on an entity
		// starts watching it for future activity (Slack-channel-style). On
		// conflict we keep the existing source so author/manual subscriptions
		// are never downgraded to 'commenter'.
		await tx
			.insert(subscriptions)
			.values({
				workspaceId,
				actorId,
				entityType: created.entityType,
				entityId: created.entityId,
				source: 'commenter',
			})
			.onConflictDoNothing({
				target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
			})

		return { comment: created, agentMentions: mentions }
	})

	// Fire-and-forget: spawn an agent session per @mentioned agent so the agent
	// can read the comment and reply. Session creation happens after the
	// transaction commits so a failure here doesn't roll back the comment or
	// notifications — stuck pending sessions are recovered by the watchdog.
	for (const mention of agentMentions) {
		sessionManager
			.createSession(workspaceId, {
				actorId: mention.agentId,
				actionPrompt: buildMentionPrompt({
					objectId: body.entity_id,
					commenterActorId: actorId,
					content: body.content,
					notificationId: mention.notificationId,
				}),
				config: {
					mention: {
						object_id: body.entity_id,
						commenter_actor_id: actorId,
						notification_id: mention.notificationId,
						comment_event_id: comment.id,
					},
				},
				createdBy: actorId,
			})
			.catch((err) =>
				logger.error('Failed to create session for @mentioned agent', {
					agentId: mention.agentId,
					objectId: body.entity_id,
					notificationId: mention.notificationId,
					error: String(err),
				}),
			)
	}

	// Thread-scoped auto-replies: when this comment is a reply, also fire a
	// session for any agent who previously participated in the thread (posted
	// a comment OR was @mentioned), so threaded conversations flow without
	// requiring an explicit @mention on every message. The 5-in-a-row cap
	// inside the helper bounds runaway agent-to-agent ping-pong.
	if (parentEventId !== undefined) {
		spawnThreadReplySessions({
			db,
			sessionManager,
			workspaceId,
			actorId,
			objectId: body.entity_id,
			threadRootEventId: parentEventId,
			newCommentEventId: comment.id,
			newCommentContent: body.content,
			excludedAgentIds: new Set(agentMentions.map((m) => m.agentId)),
		}).catch((err) =>
			logger.error('Failed to spawn thread-reply sessions', {
				objectId: body.entity_id,
				threadRootEventId: parentEventId,
				error: String(err),
			}),
		)
	}

	return c.json(serializeArray([comment])[0] as z.infer<typeof eventResponseSchema>, 201)
}) as RouteHandler<typeof createCommentRoute, Env>)

async function resolveRootParentEventId(
	db: Database,
	workspaceId: string,
	entityId: string,
	parentEventId: number | undefined,
): Promise<number | undefined> {
	if (parentEventId === undefined) return undefined

	const seen = new Set<number>()
	let current: number = parentEventId
	while (!seen.has(current)) {
		seen.add(current)
		const rows: Array<{ id: number; data: unknown }> = await db
			.select({ id: events.id, data: events.data })
			.from(events)
			.where(
				and(
					eq(events.id, current),
					eq(events.workspaceId, workspaceId),
					eq(events.entityType, 'object'),
					eq(events.entityId, entityId),
					eq(events.action, 'commented'),
				),
			)
			.limit(1)
		const parent = rows[0]
		if (!parent) return undefined
		const parentData = parent.data as { parentEventId?: number | null } | null
		const nextId = parentData?.parentEventId
		if (nextId === undefined || nextId === null) return parent.id
		current = nextId
	}
	return undefined
}

function buildMentionPrompt(ctx: {
	objectId: string
	commenterActorId: string
	content: string
	notificationId: string
}): string {
	return [
		'You were @mentioned in a comment on an object. Read the comment and the object context, then decide what the right response is. The response can be any combination of:',
		'  - taking an action (updating the object, creating related work, running a tool, kicking off another session, etc.)',
		'  - posting a comment reply (to answer, discuss, acknowledge, or report what you did)',
		'  - doing nothing, if no response is warranted',
		'',
		"Let the context guide you — what is being asked explicitly, what's implied by the thread, and what would actually be useful. Action and comment aren't mutually exclusive: it's often right to do the work and post a short comment about it, or to comment first and then act, or just one or the other. Pick whatever genuinely fits.",
		'',
		`Object ID: ${ctx.objectId}`,
		`Commenter actor ID: ${ctx.commenterActorId}`,
		'Comment content:',
		'"""',
		ctx.content,
		'"""',
		'',
		`Once you have done whatever you decided to do (including if that's nothing), mark notification ${ctx.notificationId} as resolved.`,
	].join('\n')
}

// Cap on consecutive agent-authored comments at the tail of a thread. Once a
// thread has this many agent replies in a row (including the comment that just
// landed), the auto-reply trigger goes silent until a human comment breaks the
// chain — preventing runaway agent-to-agent ping-pong.
const MAX_CONSECUTIVE_AGENT_REPLIES = 5

// Upper bound on how many recent thread comments we scan when deciding who to
// auto-spawn. The consecutive-agent cap only inspects the tail and active
// participants almost always sit within the most recent comments — past this
// horizon, an agent who participated very early in a long thread may not be
// re-triggered. Bounds worst-case scan cost on huge threads.
const THREAD_LOOKBACK_LIMIT = 200

async function spawnThreadReplySessions(ctx: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	actorId: string
	objectId: string
	threadRootEventId: number
	newCommentEventId: number
	newCommentContent: string
	excludedAgentIds: Set<string>
}): Promise<void> {
	const threadComments = await ctx.db
		.select({
			id: events.id,
			actorId: events.actorId,
			actorType: actors.type,
			data: events.data,
		})
		.from(events)
		.innerJoin(actors, eq(actors.id, events.actorId))
		.where(
			and(
				eq(events.workspaceId, ctx.workspaceId),
				eq(events.entityType, 'object'),
				eq(events.entityId, ctx.objectId),
				eq(events.action, 'commented'),
				or(
					eq(events.id, ctx.threadRootEventId),
					// Compare as text rather than casting `(data->>'parentEventId')::int`:
					// the cast throws on any row with a non-numeric value in the JSON
					// field, which would tank the entire thread-reply spawn for every
					// agent in the thread. Text comparison degrades to "no match" on
					// malformed rows instead.
					sql`${events.data}->>'parentEventId' = ${String(ctx.threadRootEventId)}`,
				),
			),
		)
		.orderBy(desc(events.id))
		.limit(THREAD_LOOKBACK_LIMIT)

	// 5-in-a-row cap: walk from the most recent comment back, count how many
	// consecutive agent-authored comments sit at the tail (the new comment is
	// included since it's already inserted at this point). Stop spawning once
	// the cap is reached.
	let consecutiveAgents = 0
	for (const row of threadComments) {
		if (row.actorType === 'agent') consecutiveAgents++
		else break
	}
	if (consecutiveAgents >= MAX_CONSECUTIVE_AGENT_REPLIES) {
		logger.info('Skipping thread-reply auto-spawn (consecutive agent cap reached)', {
			objectId: ctx.objectId,
			threadRootEventId: ctx.threadRootEventId,
			consecutiveAgents,
		})
		return
	}

	// Collect candidate agents from two sources: actors who posted a comment in
	// the thread, and actors who were @mentioned in any comment in the thread.
	const agentParticipantIds = new Set<string>()
	const mentionedCandidateIds = new Set<string>()
	for (const row of threadComments) {
		if (row.actorType === 'agent' && row.actorId !== ctx.actorId) {
			agentParticipantIds.add(row.actorId)
		}
		const data = row.data as { mentions?: string[] | null } | null
		if (data?.mentions) {
			for (const id of data.mentions) {
				if (id !== ctx.actorId) mentionedCandidateIds.add(id)
			}
		}
	}

	// Resolve any mentioned candidates that aren't already confirmed as agents
	// (commenters were filtered by type at the join, mentions weren't).
	const toResolve = Array.from(mentionedCandidateIds).filter((id) => !agentParticipantIds.has(id))
	if (toResolve.length > 0) {
		const resolved = await ctx.db
			.select({ id: actors.id, type: actors.type })
			.from(actors)
			.where(inArray(actors.id, toResolve))
		for (const a of resolved) {
			if (a.type === 'agent') agentParticipantIds.add(a.id)
		}
	}

	// Drop any agent already being spawned via the @mention path for this
	// same comment — the mention session carries a notification id and takes
	// precedence over the implicit thread-reply trigger.
	const threadReplyAgentIds = Array.from(agentParticipantIds).filter(
		(id) => !ctx.excludedAgentIds.has(id),
	)

	for (const agentId of threadReplyAgentIds) {
		ctx.sessionManager
			.createSession(ctx.workspaceId, {
				actorId: agentId,
				actionPrompt: buildThreadReplyPrompt({
					objectId: ctx.objectId,
					commenterActorId: ctx.actorId,
					content: ctx.newCommentContent,
					threadRootEventId: ctx.threadRootEventId,
				}),
				config: {
					thread_reply: {
						object_id: ctx.objectId,
						comment_event_id: ctx.newCommentEventId,
						thread_root_event_id: ctx.threadRootEventId,
						commenter_actor_id: ctx.actorId,
					},
				},
				createdBy: ctx.actorId,
			})
			.catch((err) =>
				logger.error('Failed to create thread-reply session', {
					agentId,
					objectId: ctx.objectId,
					threadRootEventId: ctx.threadRootEventId,
					error: String(err),
				}),
			)
	}
}

function buildThreadReplyPrompt(ctx: {
	objectId: string
	commenterActorId: string
	content: string
	threadRootEventId: number
}): string {
	return [
		'A new comment was added to a comment thread you previously participated in. You were NOT @mentioned — you are being notified because you commented or were @mentioned earlier in this thread.',
		'',
		'Read the thread context (use the MCP tools to fetch comments on this object) and assess whether a reply from you adds value. If a reply is helpful, post it as a reply in the same thread. If not, take no action — silence is a valid outcome.',
		'',
		`Object ID: ${ctx.objectId}`,
		`Thread root comment event ID: ${ctx.threadRootEventId}`,
		`Commenter actor ID: ${ctx.commenterActorId}`,
		'New comment content:',
		'"""',
		ctx.content,
		'"""',
	].join('\n')
}

export default app
