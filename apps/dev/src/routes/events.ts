import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	files,
	notifications,
	objects,
	sessions,
	subscriptions,
} from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { createCommentSchema, eventQuerySchema, resendCommentSchema } from '@maskin/shared'
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
	const { parentEventId, opActorId } = await resolveRootParentEventId(
		db,
		workspaceId,
		body.entity_id,
		body.parent_event_id,
	)

	const { comment, agentMentions, mentionedSubscriberCount } = await db.transaction(async (tx) => {
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
					metadata: body.metadata,
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

		// Auto-subscribe the thread OP when this is a reply, so they're
		// notified of all follow-up messages — Slack participant model. Skip
		// when the OP is the same as the current commenter (already subscribed
		// above). onConflictDoNothing preserves any existing source.
		if (parentEventId !== undefined && opActorId && opActorId !== actorId) {
			await tx
				.insert(subscriptions)
				.values({
					workspaceId,
					actorId: opActorId,
					entityType: created.entityType,
					entityId: created.entityId,
					source: 'commenter',
				})
				.onConflictDoNothing({
					target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
				})
		}

		// Auto-subscribe @-mentioned actors so the comment reaches their For You
		// page even if they weren't already subscribed. Dedup the mention list
		// and skip the commenter (they were just auto-subscribed above).
		// onConflictDoNothing preserves any existing source — a mention never
		// downgrades manual/author/commenter.
		let mentionedSubscriberCount = 0
		if (body.mentions?.length) {
			const uniqueMentioned = Array.from(new Set(body.mentions)).filter((id) => id !== actorId)
			if (uniqueMentioned.length > 0) {
				await tx
					.insert(subscriptions)
					.values(
						uniqueMentioned.map((mentionedActorId) => ({
							workspaceId,
							actorId: mentionedActorId,
							entityType: created.entityType,
							entityId: created.entityId,
							source: 'mentioned' as const,
						})),
					)
					.onConflictDoNothing({
						target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
					})
				mentionedSubscriberCount = uniqueMentioned.length
			}
		}

		return { comment: created, agentMentions: mentions, mentionedSubscriberCount }
	})

	if (parentEventId !== undefined && opActorId && opActorId !== actorId) {
		logger.info('Auto-subscribed thread OP to commented object', {
			objectId: body.entity_id,
			commentEventId: comment.id,
			opActorId,
		})
	}

	if (mentionedSubscriberCount > 0) {
		logger.info('Auto-subscribed @-mentioned actors to commented object', {
			objectId: body.entity_id,
			commentEventId: comment.id,
			mentionedSubscriberCount,
		})
	}

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

// POST /api/events/:id/resend — Edit-and-restart the agent reply triggered by a
// prior comment. Per architecture decision 2 (events.ts:160-228 is the only
// agent-spawn site for `commented`), this is the second explicit spawn site,
// scoped to "restart against the corrected message state". Edits via T2's
// `comment_edited` route do NOT spawn; this one does.
const resendCommentRoute = createRoute({
	method: 'post',
	path: '/{id}/resend',
	tags: ['events'],
	summary: 'Edit (optional) and restart the agent reply for a prior comment',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.coerce.number().int().positive() }),
		body: {
			content: { 'application/json': { schema: resendCommentSchema } },
		},
	},
	responses: {
		200: {
			description: 'Agent reply restarted',
			content: {
				'application/json': {
					schema: z.object({
						event: eventResponseSchema,
						restarts: z.array(
							z.object({
								kind: z.enum(['resumed', 'superseded']),
								sessionId: z.string().uuid(),
								supersededSessionId: z.string().uuid().optional(),
							}),
						),
					}),
				},
			},
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not the comment author',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Comment not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(resendCommentRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id: eventId } = c.req.valid('param')
	const body = c.req.valid('json')

	// Load the original comment, scoped to workspace so a cross-workspace
	// guessed id can't probe existence.
	const [original] = await db
		.select()
		.from(events)
		.where(
			and(
				eq(events.id, eventId),
				eq(events.workspaceId, workspaceId),
				eq(events.action, 'commented'),
				eq(events.entityType, 'object'),
			),
		)
		.limit(1)

	if (!original) {
		return c.json(createApiError('NOT_FOUND', 'Comment not found'), 404 as never)
	}

	// Only the comment's author can restart their own message — same rule as
	// edit/delete (T2/T4). Foreign restarts would let any workspace member
	// re-spawn another user's agent run.
	if (original.actorId !== actorId) {
		return c.json(
			createApiError('FORBIDDEN', 'Only the comment author can resend it'),
			403 as never,
		)
	}

	const originalData = (original.data as Record<string, unknown> | null) ?? {}
	const updatedContent =
		typeof body.content === 'string' && body.content.length > 0
			? body.content
			: ((originalData.content as string | undefined) ?? '')

	if (!updatedContent) {
		return c.json(createApiError('BAD_REQUEST', 'Comment has no content to resend'), 400)
	}

	// Edit-in-place: when the client passes new content, update the source
	// event's data so the agent's next read sees the corrected message. This
	// is the single combined "Save & restart agent" call from T2's button.
	const editedAt = new Date().toISOString()
	if (typeof body.content === 'string' && body.content !== originalData.content) {
		await db
			.update(events)
			.set({
				data: { ...originalData, content: body.content, editedAt },
			})
			.where(eq(events.id, eventId))
	}

	// Find every mention session that this comment originally spawned. We key
	// on `config.mention.comment_event_id` — the events route writes that
	// field when the comment @mentions an agent. The cast to text avoids
	// errors on rows where the JSON value isn't a number.
	const linkedSessions = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, workspaceId),
				sql`${sessions.config}->'mention'->>'comment_event_id' = ${String(eventId)}`,
			),
		)

	const restarts: Array<{
		kind: 'resumed' | 'superseded'
		sessionId: string
		supersededSessionId?: string
	}> = []

	for (const prior of linkedSessions) {
		const mention = (prior.config as Record<string, unknown> | null)?.mention as
			| { object_id?: string; notification_id?: string }
			| undefined
		const objectId = mention?.object_id
		if (!objectId) {
			logger.warn('Skipping restart — prior session has no mention.object_id', {
				priorSessionId: prior.id,
				eventId,
			})
			continue
		}

		const actionPrompt = buildMentionPrompt({
			objectId,
			commenterActorId: actorId,
			content: updatedContent,
			notificationId: mention?.notification_id ?? '',
		})

		try {
			const result = await sessionManager.restartSession(prior.id, {
				actionPrompt,
				objectId,
				createdBy: actorId,
				turnContent: updatedContent,
			})
			restarts.push(result)
		} catch (err) {
			logger.error('Failed to restart prior session on resend', {
				priorSessionId: prior.id,
				eventId,
				error: String(err),
			})
		}
	}

	// Audit event so the timeline can render the "user resent" affordance and
	// downstream agents can read the restart history. Never spawns on its own.
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'comment_resent',
		entityType: 'object',
		entityId: original.entityId,
		data: {
			originalEventId: eventId,
			restarts,
			editedAt: typeof body.content === 'string' ? editedAt : undefined,
		},
	})

	logger.info('Comment resent — agent reply restarted', {
		eventId,
		workspaceId,
		restartCount: restarts.length,
		linkedSessionCount: linkedSessions.length,
	})

	const updated = await db
		.select()
		.from(events)
		.where(eq(events.id, eventId))
		.limit(1)
		.then((rows) => rows[0])

	return c.json(
		{
			event: serializeArray([updated ?? original])[0] as z.infer<typeof eventResponseSchema>,
			restarts,
		},
		200,
	)
}) as RouteHandler<typeof resendCommentRoute, Env>)

type ResolvedParent = { parentEventId: number | undefined; opActorId: string | null }

async function resolveRootParentEventId(
	db: Database,
	workspaceId: string,
	entityId: string,
	parentEventId: number | undefined,
): Promise<ResolvedParent> {
	if (parentEventId === undefined) return { parentEventId: undefined, opActorId: null }

	const seen = new Set<number>()
	let current: number = parentEventId
	while (!seen.has(current)) {
		seen.add(current)
		const rows: Array<{ id: number; actorId: string; data: unknown }> = await db
			.select({ id: events.id, actorId: events.actorId, data: events.data })
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
		if (!parent) return { parentEventId: undefined, opActorId: null }
		const parentData = parent.data as { parentEventId?: number | null } | null
		const nextId = parentData?.parentEventId
		if (nextId === undefined || nextId === null)
			return { parentEventId: parent.id, opActorId: parent.actorId ?? null }
		current = nextId
	}
	return { parentEventId: undefined, opActorId: null }
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
