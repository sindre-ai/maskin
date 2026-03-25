import type { Database } from '@ai-native/db'
import { events, notifications } from '@ai-native/db/schema'
import {
	createNotificationSchema,
	notificationQuerySchema,
	respondNotificationSchema,
	updateNotificationSchema,
} from '@ai-native/shared'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import {
	errorSchema,
	idParamSchema,
	notificationResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

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
	const { status, type, limit, offset } = c.req.valid('query')

	const conditions = [eq(notifications.workspaceId, workspaceId)]
	if (status) conditions.push(eq(notifications.status, status))
	if (type) conditions.push(eq(notifications.type, type))

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
		headers: workspaceIdHeader,
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
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	// Verify notification exists and actor is a workspace member
	const [existing] = await db
		.select()
		.from(notifications)
		.where(eq(notifications.id, id))
		.limit(1)

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

	if (!updated) return c.json(createApiError('INTERNAL_ERROR', 'Failed to update notification'), 500)

	await db.insert(events).values({
		workspaceId,
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
		404: {
			description: 'Notification not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(respondNotificationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
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

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'responded',
		entityType: 'notification',
		entityId: updated.id,
		data: { response: body.response },
	})

	// Container session resume is handled via session-manager (Docker pause/resume)

	return c.json(serialize(updated) as z.infer<typeof notificationResponseSchema>)
}) as RouteHandler<typeof respondNotificationRoute, Env>)

// DELETE /api/notifications/:id
const deleteNotificationRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Notifications'],
	summary: 'Delete a notification',
	request: {
		headers: workspaceIdHeader,
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
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [existing] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1)

	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Notification not found'), 404)
	}

	await db.delete(notifications).where(eq(notifications.id, id))

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'deleted',
		entityType: 'notification',
		entityId: id,
		data: existing,
	})

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteNotificationRoute, Env>)

export default app
