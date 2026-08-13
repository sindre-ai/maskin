import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, notifications, sessions } from '@maskin/db/schema'
import {
	bulkRespondNotificationSchema,
	createNotificationSchema,
	notificationQuerySchema,
	respondNotificationSchema,
	reverseNotificationSchema,
	updateNotificationSchema,
} from '@maskin/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	errorSchema,
	idParamSchema,
	notificationResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: SessionManager
	}
}

type NotificationRow = typeof notifications.$inferSelect

// Common subset of Database + PgTransaction used by helpers that need to run
// inside either. Mirrors the pattern in workspace-bootstrap.ts.
type Executor = Pick<Database, 'select' | 'insert' | 'update'>

// Delay between a human's response and the reaper waking the source agent.
// A shorter delay would surface the wake before the UI's reverse window
// closes; a longer delay would leave humans staring at "waiting on agent"
// past the point where their decision is committed.
const DISPATCH_DELAY_MS = 6000

// Server-side upper bound for the reverse-decision window. Anything past
// this and the caller gets a 400 — even if the reaper hasn't dispatched
// the wake yet, the caller's mental model of "I just decided" has expired.
const REVERSE_WINDOW_MS = 6000

// Query flag on POST /:id/respond and POST /bulk-respond. When 'immediate',
// the API bypasses the deferred-wake window and calls wakeSourceAgent
// synchronously — kept for MCP callers and integration tests that assert
// "agent runs after respond" and don't tolerate the 6s undo window.
const dispatchQuerySchema = z.object({
	dispatch: z.enum(['immediate']).optional(),
})

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// POST /api/notifications
const createNotificationRoute = createRoute({
	method: 'post',
	path: '/',
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
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createNotificationRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

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

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'notification',
		entityId: created.id,
		data: created,
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
	const { status, type, object_id, attention_needed, limit, offset } = c.req.valid('query')

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
	if (attention_needed !== undefined) {
		// metadata is JSONB; the schema wall (T2) puts `attention_needed` at the
		// top of that object. Match on the JSONB text extract so partial-index
		// pushdown stays available if we add one later.
		conditions.push(
			attention_needed
				? sql`${notifications.metadata}->>'attention_needed' = 'true'`
				: sql`(${notifications.metadata}->>'attention_needed' IS DISTINCT FROM 'true')`,
		)
	}

	const results = await db
		.select()
		.from(notifications)
		.where(and(...conditions))
		.orderBy(notifications.createdAt)
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

	// Verify notification exists and actor is a workspace member
	const [existing] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1)

	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
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

	await db.insert(events).values({
		workspaceId: existing.workspaceId,
		actorId,
		action: 'updated',
		entityType: 'notification',
		entityId: updated.id,
		data: updated,
	})

	return c.json(serialize(updated) as z.infer<typeof notificationResponseSchema>)
}) as RouteHandler<typeof updateNotificationRoute, Env>)

// POST /api/notifications/:id/respond — Human responds to a notification. By
// default the source agent is woken by the T4 reaper after DISPATCH_DELAY_MS
// (leaves room for POST /:id/reverse to undo). Pass `?dispatch=immediate` to
// wake synchronously — the escape hatch for MCP callers and tests that must
// see the agent run before the response returns.
const respondNotificationRoute = createRoute({
	method: 'post',
	path: '/{id}/respond',
	tags: ['Notifications'],
	summary: 'Respond to a notification and resume the agent',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		query: dispatchQuerySchema,
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
	const { dispatch } = c.req.valid('query')
	const body = c.req.valid('json')

	// Load the notification
	const [notification] = await db
		.select()
		.from(notifications)
		.where(eq(notifications.id, id))
		.limit(1)

	if (!notification || !(await isWorkspaceMember(db, actorId, notification.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
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

	const immediate = dispatch === 'immediate'
	const updated = await applyRespond({ db, notification, response: body.response, immediate })

	if (!updated)
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to update notification'), 500)

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'responded',
		entityType: 'notification',
		entityId: updated.id,
		data: { response: body.response, dispatch: immediate ? 'immediate' : 'deferred' },
	})

	if (immediate) {
		// Awaited so the caller sees the wake before the response returns —
		// the whole point of `?dispatch=immediate` is that MCP tests can
		// assert on downstream session state without polling.
		await wakeSourceAgent({
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
			logger.error('Failed to wake source agent (immediate dispatch)', {
				notificationId: updated.id,
				sourceActorId: notification.sourceActorId,
				error: String(err),
			}),
		)
	}

	return c.json(serialize(updated) as z.infer<typeof notificationResponseSchema>)
}) as RouteHandler<typeof respondNotificationRoute, Env>)

// POST /api/notifications/bulk-respond — Apply the same response to N
// notifications in one transaction. Dedupes wakes per sourceActorId so a
// batch that touches 10 cards from the same agent produces one wake, not
// 10. Same deferred-wake code path as single respond; same `?dispatch=
// immediate` escape hatch.
const bulkRespondNotificationsRoute = createRoute({
	method: 'post',
	path: '/bulk-respond',
	tags: ['Notifications'],
	summary: 'Respond to multiple notifications in one transaction',
	request: {
		headers: workspaceIdHeader,
		query: dispatchQuerySchema,
		body: {
			content: {
				'application/json': {
					schema: bulkRespondNotificationSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'All notifications resolved',
			content: { 'application/json': { schema: z.array(notificationResponseSchema) } },
		},
		400: {
			description: 'One or more notifications could not be resolved',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(bulkRespondNotificationsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const sessionManager = c.get('sessionManager')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { dispatch } = c.req.valid('query')
	const { ids, response } = c.req.valid('json')

	const immediate = dispatch === 'immediate'

	// De-duplicate ids while preserving input order for the response array.
	const uniqueIds = Array.from(new Set(ids))

	// Membership check runs outside the transaction — it doesn't depend on
	// notification state and it lets us reject non-members without holding
	// a txn open. All ids in a bulk call must share the caller's workspace
	// (enforced inside the txn below), so one probe is enough.
	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(
			createApiError('BAD_REQUEST', 'Not a workspace member', [
				{ field: 'x-workspace-id', message: 'Actor is not a member of this workspace' },
			]),
			400,
		)
	}

	const updates = await db
		.transaction(async (tx) => {
			const rows = await tx.select().from(notifications).where(inArray(notifications.id, uniqueIds))

			// All ids must resolve to a row, all rows must belong to the caller's
			// workspace, all rows must be respondable. Any miss aborts the whole
			// batch so a partial success can't leak "which ids belong to which
			// workspace".
			if (rows.length !== uniqueIds.length) {
				throw new BulkRespondError('One or more notifications not found', 'not_found', uniqueIds)
			}
			for (const row of rows) {
				if (row.workspaceId !== workspaceId) {
					throw new BulkRespondError('Notification not in workspace', 'wrong_workspace', [row.id])
				}
				if (row.status !== 'pending' && row.status !== 'seen') {
					throw new BulkRespondError(
						`Notification ${row.id} already responded to (status='${row.status}')`,
						'wrong_status',
						[row.id],
					)
				}
			}

			// Map by id for O(1) lookup as we walk ids in input order.
			const byId = new Map(rows.map((r) => [r.id, r]))
			const seenSources = new Set<string>()
			const updated: NotificationRow[] = []

			for (const id of uniqueIds) {
				const row = byId.get(id) as NotificationRow
				// Dedupe: only the first row per unique sourceActorId schedules a
				// wake (deferred) or is remembered for the immediate loop below.
				const isFirstForSource = !seenSources.has(row.sourceActorId)
				seenSources.add(row.sourceActorId)

				const scheduleWake = !immediate && isFirstForSource
				const applied = await applyRespond({
					db: tx,
					notification: row,
					response,
					immediate,
					scheduleWake,
				})
				if (!applied) {
					throw new BulkRespondError('Update failed', 'update_failed', [id])
				}
				updated.push(applied)
			}

			await tx.insert(events).values(
				updated.map((row) => ({
					workspaceId,
					actorId,
					action: 'responded',
					entityType: 'notification',
					entityId: row.id,
					data: { response, dispatch: immediate ? 'immediate' : 'deferred', bulk: true },
				})),
			)

			return { updated, seenSources }
		})
		.catch((err) => {
			if (err instanceof BulkRespondError) return err
			throw err
		})

	if (updates instanceof BulkRespondError) {
		return c.json(
			createApiError('BAD_REQUEST', updates.message, [{ field: 'ids', message: updates.reason }]),
			400,
		)
	}

	if (immediate) {
		// Immediate mode: one wake per unique sourceActorId. Deferred mode is
		// the reaper's problem — it reads `dispatch_at` and dedupes naturally
		// because we only set that column on the first row per source.
		const seenAgents = new Set<string>()
		for (const row of updates.updated) {
			if (seenAgents.has(row.sourceActorId)) continue
			seenAgents.add(row.sourceActorId)
			await wakeSourceAgent({
				sessionManager,
				db,
				workspaceId: row.workspaceId,
				sourceActorId: row.sourceActorId,
				linkedSessionId: row.sessionId,
				notificationId: row.id,
				title: row.title,
				content: row.content,
				response,
				createdBy: actorId,
			}).catch((err) =>
				logger.error('Failed to wake source agent (bulk immediate)', {
					notificationId: row.id,
					sourceActorId: row.sourceActorId,
					error: String(err),
				}),
			)
		}
	}

	return c.json(serializeArray(updates.updated) as z.infer<typeof notificationResponseSchema>[])
}) as RouteHandler<typeof bulkRespondNotificationsRoute, Env>)

// POST /api/notifications/:id/reverse — undo a resolved notification within
// REVERSE_WINDOW_MS of the resolution. Restores `status='pending'` and
// clears the pending wake so the reaper doesn't fire on a decision that
// was withdrawn. Server clock only — client timestamps are ignored.
const reverseNotificationRoute = createRoute({
	method: 'post',
	path: '/{id}/reverse',
	tags: ['Notifications'],
	summary: 'Reverse a recently resolved notification (undo)',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: reverseNotificationSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Notification restored to pending',
			content: { 'application/json': { schema: notificationResponseSchema } },
		},
		400: {
			description: 'Reverse window elapsed or notification not resolved',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Notification not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(reverseNotificationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [notification] = await db
		.select()
		.from(notifications)
		.where(eq(notifications.id, id))
		.limit(1)

	if (!notification || !(await isWorkspaceMember(db, actorId, notification.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
	}

	if (notification.status !== 'resolved' || !notification.resolvedAt) {
		return c.json(
			createApiError('BAD_REQUEST', 'Only resolved notifications can be reversed', [
				{
					field: 'status',
					message: `Current status is '${notification.status}', expected 'resolved'`,
				},
			]),
			400,
		)
	}

	const elapsed = Date.now() - notification.resolvedAt.getTime()
	if (elapsed > REVERSE_WINDOW_MS) {
		return c.json(
			createApiError('BAD_REQUEST', 'Reverse window has elapsed', [
				{
					field: 'resolvedAt',
					message: `Reversal must happen within ${REVERSE_WINDOW_MS}ms of resolution (elapsed ${elapsed}ms)`,
				},
			]),
			400,
		)
	}

	const existingMetadata = (notification.metadata ?? {}) as Record<string, unknown>
	const { response: _reversed, ...metadataWithoutResponse } = existingMetadata

	const [updated] = await db
		.update(notifications)
		.set({
			status: 'pending',
			metadata: metadataWithoutResponse,
			resolvedAt: null,
			dispatchAt: null,
			wakeDispatched: false,
			updatedAt: new Date(),
		})
		.where(eq(notifications.id, id))
		.returning()

	if (!updated)
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to reverse notification'), 500)

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'reversed',
		entityType: 'notification',
		entityId: updated.id,
		data: { reversedAt: new Date().toISOString() },
	})

	return c.json(serialize(updated) as z.infer<typeof notificationResponseSchema>)
}) as RouteHandler<typeof reverseNotificationRoute, Env>)

// Shared write path for POST /:id/respond and POST /bulk-respond.
// `scheduleWake` lets the bulk-respond handler suppress `dispatch_at` on
// duplicate-source rows so the reaper doesn't wake the same agent N times.
async function applyRespond(ctx: {
	db: Executor
	notification: NotificationRow
	response: unknown
	immediate: boolean
	scheduleWake?: boolean
}): Promise<NotificationRow | undefined> {
	const { db, notification, response, immediate } = ctx
	const scheduleWake = ctx.scheduleWake ?? true
	const now = new Date()
	const existingMetadata = (notification.metadata ?? {}) as Record<string, unknown>

	const updateData: Record<string, unknown> = {
		status: 'resolved',
		metadata: { ...existingMetadata, response },
		resolvedAt: now,
		updatedAt: now,
	}
	if (!immediate && scheduleWake) {
		updateData.dispatchAt = new Date(now.getTime() + DISPATCH_DELAY_MS)
		updateData.wakeDispatched = false
	}

	const [updated] = await db
		.update(notifications)
		.set(updateData)
		.where(eq(notifications.id, notification.id))
		.returning()

	return updated
}

class BulkRespondError extends Error {
	constructor(
		message: string,
		public readonly reason: 'not_found' | 'wrong_workspace' | 'wrong_status' | 'update_failed',
		public readonly ids: string[],
	) {
		super(message)
		this.name = 'BulkRespondError'
	}
}

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
		const [linked] = await ctx.db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, ctx.linkedSessionId))
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
		continuationOfSessionId = ctx.linkedSessionId
	}

	await ctx.sessionManager.createSession(ctx.workspaceId, {
		actorId: ctx.sourceActorId,
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

	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
	}

	await db.delete(notifications).where(eq(notifications.id, id))

	await db.insert(events).values({
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
