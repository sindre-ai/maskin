import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, notifications, objects, sessions, workspaceMembers } from '@maskin/db/schema'
import {
	FOR_YOU_KIND,
	createNotificationSchema,
	notificationQuerySchema,
	respondNotificationSchema,
	updateNotificationSchema,
} from '@maskin/shared'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { trackCreateNotificationCalled } from '../lib/analytics/notification-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import {
	errorSchema,
	idParamSchema,
	notificationResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import {
	ViewerReadOnlyError,
	assertWorkspaceWriterRole,
	getWorkspaceRole,
	isWorkspaceMember,
	isWorkspaceWriter,
} from '../lib/workspace-auth'
import { assertInWorkspace } from '../lib/workspace-scope'
import { findChiefOfStaffId } from '../services/chief-of-staff-chat'
import { startSession } from '../services/session-lifecycle'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		/** Caller's role in the X-Workspace-Id workspace, set by authMiddleware. */
		workspaceRole?: string
		actorType: string
		sessionManager: SessionManager
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/**
 * Edit and delete check for a notification loaded by ID. Returns false for a
 * non-member (the caller answers 404). A viewer may change only a notification
 * addressed to them, so they can still mark their own read; changing anyone
 * else's is a 403, as for every other write. A viewer may not write metadata
 * even on their own: metadata.response is what a responder leaves for the
 * source agent, and responding is a writer action.
 */
async function mayChangeNotification(
	db: Database,
	actorId: string,
	notification: { workspaceId: string; targetActorId: string | null },
	editsMetadata = false,
): Promise<boolean> {
	const role = await getWorkspaceRole(db, actorId, notification.workspaceId)
	if (role === null) return false
	if (role === 'viewer' && (notification.targetActorId !== actorId || editsMetadata)) {
		throw new ViewerReadOnlyError()
	}
	return true
}

const isForYouMetadata = (metadata: unknown) =>
	(metadata as { kind?: unknown } | null | undefined)?.kind === FOR_YOU_KIND

const forYouForbidden = () =>
	createApiError('FORBIDDEN', 'Only the Chief of Staff can curate For You items')

/**
 * Extra gate for For You items on edit and delete. The Chief of Staff may do
 * anything to them; the person an item is for may dismiss or delete it but not
 * rewrite its metadata (rank, headline); everyone else is refused. Turning any
 * notification into a For You item counts as curating.
 */
async function mayCurateForYou(
	db: Database,
	actorId: string,
	existing: { workspaceId: string; targetActorId: string | null; metadata: unknown },
	newMetadata?: unknown,
): Promise<boolean> {
	if (!isForYouMetadata(existing.metadata) && !isForYouMetadata(newMetadata)) return true
	if (existing.targetActorId === actorId && !newMetadata) return true
	return (await findChiefOfStaffId(db, existing.workspaceId)) === actorId
}

// POST /api/notifications
const createNotificationRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['Notifications'],
	summary: 'Create a notification',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: createNotificationSchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Notification created',
			content: { 'application/json': { schema: notificationResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Only the Chief of Staff can curate For You items',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Referenced object or session not found in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createNotificationRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const actorType = c.get('actorType')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const body = c.req.valid('json')

	// For You items are the Chief of Staff's curation: nobody else writes them, and
	// they may only point at a person in this workspace and at its own objects.
	if (isForYouMetadata(body.metadata)) {
		if ((await findChiefOfStaffId(db, workspaceId)) !== actorId) {
			return c.json(forYouForbidden(), 403)
		}
		const [target] = body.target_actor_id
			? await db
					.select({ id: actors.id })
					.from(workspaceMembers)
					.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
					.where(
						and(
							eq(workspaceMembers.workspaceId, workspaceId),
							eq(workspaceMembers.actorId, body.target_actor_id),
							eq(actors.type, 'human'),
						),
					)
					.limit(1)
			: []
		if (!target) {
			return c.json(
				createApiError('BAD_REQUEST', 'target_actor_id must be a human member of this workspace'),
				400,
			)
		}
		if (body.object_id) {
			const [obj] = await db
				.select({ id: objects.id })
				.from(objects)
				.where(and(eq(objects.id, body.object_id), eq(objects.workspaceId, workspaceId)))
				.limit(1)
			if (!obj) return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
		}
		if (body.session_id) {
			const [session] = await db
				.select({ id: sessions.id })
				.from(sessions)
				.where(and(eq(sessions.id, body.session_id), eq(sessions.workspaceId, workspaceId)))
				.limit(1)
			if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
		}
	}

	// The actors, object and session a notification names are later used to wake
	// agents and resume sessions, so each must belong to this workspace.
	await assertInWorkspace(db, workspaceId, {
		actors: [body.source_actor_id, body.target_actor_id],
		objects: [body.object_id],
		sessions: [body.session_id],
	})

	const [created] = await db
		.insert(notifications)
		.values({
			workspaceId,
			type: body.type,
			title: body.title,
			content: body.content,
			metadata: body.metadata,
			sourceActorId: body.source_actor_id,
			targetActorId: body.target_actor_id,
			objectId: body.object_id,
			sessionId: body.session_id,
			status: 'pending',
		})
		.returning()

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create notification'), 500)
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'notification',
		entityId: created.id,
		data: created,
	})

	// Fire-and-forget ship-metric emit: the parent bet needs a PostHog-visible
	// count of agent-initiated notification creates over 7 days post-migration.
	// Filter to agent actors only so human UI actions don't pollute the count.
	void trackCreateNotificationCalled({
		db,
		workspaceId,
		actorId,
		actorType,
		notificationId: created.id,
		notificationType: created.type,
	})

	return c.json(serialize(created) as z.infer<typeof notificationResponseSchema>, 201)
})

// GET /api/notifications
const listNotificationsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Notifications'],
	summary: 'List notifications in workspace',
	request: {
		headers: workspaceIdHeader,
		query: notificationQuerySchema,
	},
	responses: {
		200: {
			description: 'List of notifications',
			content: { 'application/json': { schema: z.array(notificationResponseSchema) } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listNotificationsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { status, type, object_id, kind, limit, offset, order } = c.req.valid('query')

	const conditions = [eq(notifications.workspaceId, workspaceId)]
	if (status) {
		if (status.length === 1) {
			conditions.push(eq(notifications.status, status[0] as string))
		} else {
			conditions.push(inArray(notifications.status, status))
		}
	}
	if (type) conditions.push(eq(notifications.type, type))
	if (object_id) conditions.push(eq(notifications.objectId, object_id))
	if (kind) conditions.push(sql`${notifications.metadata}->>'kind' = ${kind}`)
	// Push-only rows (chat replies) exist to drive a push, not to be listed.
	conditions.push(sql`coalesce(${notifications.metadata}->>'push_only', 'false') <> 'true'`)

	const results = await db
		.select()
		.from(notifications)
		.where(and(...conditions))
		.orderBy(order === 'desc' ? desc(notifications.createdAt) : asc(notifications.createdAt))
		.limit(limit)
		.offset(offset)

	return c.json(serializeArray(results) as z.infer<typeof notificationResponseSchema>[])
}) as RouteHandler<typeof listNotificationsRoute, Env>)

// GET /api/notifications/:id
const getNotificationRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Notifications'],
	summary: 'Get notification by ID',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'Notification found',
			content: { 'application/json': { schema: notificationResponseSchema } },
		},
		404: {
			description: 'Notification not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getNotificationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [notification] = await db
		.select()
		.from(notifications)
		.where(eq(notifications.id, id))
		.limit(1)

	if (!notification || !(await isWorkspaceMember(db, actorId, notification.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
	}

	return c.json(serialize(notification) as z.infer<typeof notificationResponseSchema>)
}) as RouteHandler<typeof getNotificationRoute, Env>)

// PATCH /api/notifications/:id
const updateNotificationRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['Notifications'],
	summary: 'Update a notification',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateNotificationSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Notification updated',
			content: { 'application/json': { schema: notificationResponseSchema } },
		},
		403: {
			description: 'Only the Chief of Staff can curate For You items',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Notification not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateNotificationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	// Verify notification exists and actor may change it
	const [existing] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1)

	if (!existing || !(await mayChangeNotification(db, actorId, existing, !!body.metadata))) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
	}
	if (!(await mayCurateForYou(db, actorId, existing, body.metadata))) {
		return c.json(forYouForbidden(), 403)
	}

	const updateData: Record<string, unknown> = { updatedAt: new Date() }
	if (body.status) {
		updateData.status = body.status
		if (body.status === 'resolved') {
			updateData.resolvedAt = new Date()
		}
	}
	if (body.metadata) updateData.metadata = body.metadata

	const [updated] = await db
		.update(notifications)
		.set(updateData)
		.where(eq(notifications.id, id))
		.returning()

	if (!updated)
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to update notification'), 500)

	await recordEvent(db, {
		workspaceId: existing.workspaceId,
		actorId,
		action: 'updated',
		entityType: 'notification',
		entityId: updated.id,
		data: updated,
	})

	return c.json(serialize(updated) as z.infer<typeof notificationResponseSchema>)
}) as RouteHandler<typeof updateNotificationRoute, Env>)

// POST /api/notifications/:id/respond — Human responds to a notification, resumes agent
const respondNotificationRoute = createRoute({
	method: 'post',
	path: '/{id}/respond',
	'x-viewer-policy': 'writer',
	tags: ['Notifications'],
	summary: 'Respond to a notification and resume the agent',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: respondNotificationSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Response recorded, agent resumed',
			content: { 'application/json': { schema: notificationResponseSchema } },
		},
		400: {
			description: 'Cannot respond to this notification',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Only the Chief of Staff can curate For You items',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Notification not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(respondNotificationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	// Load the notification
	const [notification] = await db
		.select()
		.from(notifications)
		.where(eq(notifications.id, id))
		.limit(1)

	// The response event and the wake-up below both run in the notification's own
	// workspace, so it has to be the one the request names.
	if (
		!notification ||
		notification.workspaceId !== workspaceId ||
		!(await isWorkspaceWriter(db, actorId, notification.workspaceId))
	) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
	}
	if (!(await mayCurateForYou(db, actorId, notification))) {
		return c.json(forYouForbidden(), 403)
	}

	if (notification.status !== 'pending' && notification.status !== 'seen') {
		return c.json(
			createApiError('BAD_REQUEST', 'Notification already responded to', [
				{
					field: 'status',
					message: `Current status is '${notification.status}', expected 'pending' or 'seen'`,
				},
			]),
			400,
		)
	}

	// Store the human's response and mark as resolved
	const existingMetadata = (notification.metadata ?? {}) as Record<string, unknown>
	const [updated] = await db
		.update(notifications)
		.set({
			status: 'resolved',
			metadata: { ...existingMetadata, response: body.response },
			resolvedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(notifications.id, id))
		.returning()

	if (!updated)
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to update notification'), 500)

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'responded',
		entityType: 'notification',
		entityId: updated.id,
		data: { response: body.response },
	})

	// Fire-and-forget: wake the agent that created this notification so it can
	// act on the human's response. Prefer resuming the originating paused session
	// (preserves context); otherwise spawn a new session for the source agent.
	wakeSourceAgent({
		sessionManager,
		db,
		workspaceId: notification.workspaceId,
		sourceActorId: notification.sourceActorId,
		linkedSessionId: notification.sessionId,
		notificationId: updated.id,
		title: updated.title,
		content: updated.content,
		response: body.response,
		createdBy: actorId,
	}).catch((err) =>
		logger.error('Failed to wake source agent for notification response', {
			notificationId: updated.id,
			sourceActorId: notification.sourceActorId,
			error: String(err),
		}),
	)

	return c.json(serialize(updated) as z.infer<typeof notificationResponseSchema>)
}) as RouteHandler<typeof respondNotificationRoute, Env>)

async function wakeSourceAgent(ctx: {
	sessionManager: SessionManager
	db: Database
	workspaceId: string
	sourceActorId: string
	linkedSessionId: string | null
	notificationId: string
	title: string
	content: string | null
	response: unknown
	createdBy: string
}): Promise<void> {
	const [sourceActor] = await ctx.db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, ctx.sourceActorId))
		.limit(1)

	if (!sourceActor || sourceActor.type !== 'agent') return

	let continuationOfSessionId: string | null = null
	if (ctx.linkedSessionId) {
		// Scoped to the notification's workspace: a session id from elsewhere reads
		// as absent, so it is never resumed or named in the new session's prompt.
		const [linked] = await ctx.db
			.select({ status: sessions.status })
			.from(sessions)
			.where(and(eq(sessions.id, ctx.linkedSessionId), eq(sessions.workspaceId, ctx.workspaceId)))
			.limit(1)

		const status = linked?.status

		if (status === 'paused') {
			await ctx.sessionManager.resumeSession(ctx.linkedSessionId)
			return
		}

		// Active sessions can't be signalled — there is no stdin/mid-run prompt
		// channel into a running container. Skip rather than race: the response
		// is persisted on the notification and the agent can read it via MCP
		// when it next polls, finishes, or is auto-paused + resumed.
		if (status === 'pending' || status === 'starting' || status === 'running') {
			logger.info('Skipping wake: linked session is still active', {
				notificationId: ctx.notificationId,
				sessionId: ctx.linkedSessionId,
				status,
			})
			return
		}

		// Terminal states (completed, failed, timeout, stopped, snapshotting, etc.)
		// → spawn a new session and reference the prior one for context continuity.
		if (linked) continuationOfSessionId = ctx.linkedSessionId
	}

	await startSession({
		workspaceId: ctx.workspaceId,
		actorId: ctx.sourceActorId,
		callerKind: 'trigger',
		actionPrompt: buildResponsePrompt({
			notificationId: ctx.notificationId,
			title: ctx.title,
			content: ctx.content,
			response: ctx.response,
			continuationOfSessionId,
		}),
		config: {
			notification_response: {
				notification_id: ctx.notificationId,
				response: ctx.response,
				...(continuationOfSessionId ? { continuation_of_session_id: continuationOfSessionId } : {}),
			},
		},
		createdBy: ctx.createdBy,
		// Notification-response spawns run on the notification's own thread: the
		// linkage lives on notifications.object_id already; per spec §3.3 this
		// site passes null/null.
		initiatedFromObjectId: null,
		await: 'none',
	})
}

function buildResponsePrompt(ctx: {
	notificationId: string
	title: string
	content: string | null
	response: unknown
	continuationOfSessionId: string | null
}): string {
	const responseText =
		typeof ctx.response === 'string' ? ctx.response : JSON.stringify(ctx.response)
	return [
		'A human responded to a notification you created. Read the response and act on it.',
		'',
		...(ctx.continuationOfSessionId
			? [
					`This is a continuation of session ${ctx.continuationOfSessionId}, which has ended. Review its logs for prior context if needed.`,
					'',
				]
			: []),
		`Notification ID: ${ctx.notificationId}`,
		`Notification title: ${ctx.title}`,
		...(ctx.content ? ['Notification content:', '"""', ctx.content, '"""', ''] : ['']),
		'Human response:',
		'"""',
		responseText,
		'"""',
	].join('\n')
}

// DELETE /api/notifications/:id
const deleteNotificationRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Notifications'],
	summary: 'Delete a notification',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'Notification deleted',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
		},
		403: {
			description: 'Only the Chief of Staff can curate For You items',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Notification not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deleteNotificationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [existing] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1)

	if (!existing || !(await mayChangeNotification(db, actorId, existing))) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
	}
	if (!(await mayCurateForYou(db, actorId, existing))) {
		return c.json(forYouForbidden(), 403)
	}

	await db.delete(notifications).where(eq(notifications.id, id))

	await recordEvent(db, {
		workspaceId: existing.workspaceId,
		actorId,
		action: 'deleted',
		entityType: 'notification',
		entityId: id,
		data: existing,
	})

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteNotificationRoute, Env>)

export default app
