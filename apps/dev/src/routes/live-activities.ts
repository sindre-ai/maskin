import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { deviceTokens, liveActivityTokens, sessions } from '@maskin/db/schema'
import { liveActivityTokenResponseSchema, registerLiveActivityTokenSchema } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'
import { resolveAuditWorkspace } from './devices'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function serialize(row: typeof liveActivityTokens.$inferSelect) {
	return {
		id: row.id,
		kind: row.kind as z.infer<typeof liveActivityTokenResponseSchema>['kind'],
		device_id: row.deviceId,
		session_id: row.sessionId,
		updated_at: row.updatedAt.toISOString(),
	}
}

async function audit(
	db: Database,
	actorId: string,
	workspaceId: string | undefined,
	header: string | undefined,
	action: 'created' | 'updated' | 'deleted',
	row: typeof liveActivityTokens.$inferSelect,
) {
	try {
		const ws = workspaceId ?? (await resolveAuditWorkspace(db, actorId, header))
		if (!ws) return
		// Events fan out to every workspace member; record only that it happened.
		await recordEvent(db, {
			workspaceId: ws,
			actorId,
			action,
			entityType: 'live_activity_token',
			entityId: row.id,
		})
	} catch (err) {
		logger.warn('live activity token audit event failed', { tokenId: row.id, error: String(err) })
	}
}

// POST /api/live-activities/tokens
const registerRoute = createRoute({
	method: 'post',
	path: '/tokens',
	tags: ['Devices'],
	summary: 'Register an ActivityKit push token (push-to-start or per-activity update)',
	description:
		'`push_to_start` is one per device and rotates (upserted on device). `update` belongs to one running activity and is tied to a session (upserted on device + session). The device must be one of the caller’s registered devices.',
	request: {
		body: { content: { 'application/json': { schema: registerLiveActivityTokenSchema } } },
	},
	responses: {
		200: {
			description: 'Token registered',
			content: { 'application/json': { schema: liveActivityTokenResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Device or session not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(registerRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	const [device] = await db
		.select({ id: deviceTokens.id })
		.from(deviceTokens)
		.where(and(eq(deviceTokens.id, body.device_id), eq(deviceTokens.actorId, actorId)))
		.limit(1)
	if (!device) return c.json(createApiError('NOT_FOUND', 'Device not found'), 404)

	let sessionWorkspaceId: string | undefined
	if (body.kind === 'update') {
		// By-ID resource: the workspace comes from the session row, so check membership here.
		const [session] = await db
			.select({ workspaceId: sessions.workspaceId })
			.from(sessions)
			.where(eq(sessions.id, body.session_id as string))
			.limit(1)
		if (!session || !(await isWorkspaceMember(db, actorId, session.workspaceId))) {
			return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
		}
		sessionWorkspaceId = session.workspaceId
	}

	const now = new Date()
	const token = body.token.toLowerCase()
	const values = {
		actorId,
		deviceId: body.device_id,
		kind: body.kind,
		token,
		sessionId: body.kind === 'update' ? (body.session_id as string) : null,
		createdAt: now,
		updatedAt: now,
	}
	const [row] =
		body.kind === 'push_to_start'
			? await db
					.insert(liveActivityTokens)
					.values(values)
					.onConflictDoUpdate({
						target: [liveActivityTokens.deviceId],
						targetWhere: sql`${liveActivityTokens.kind} = 'push_to_start'`,
						set: { token, actorId, updatedAt: now },
					})
					.returning()
			: await db
					.insert(liveActivityTokens)
					.values(values)
					.onConflictDoUpdate({
						target: [liveActivityTokens.deviceId, liveActivityTokens.sessionId],
						targetWhere: sql`${liveActivityTokens.kind} = 'update'`,
						set: { token, actorId, updatedAt: now },
					})
					.returning()
	if (!row) return c.json(createApiError('INTERNAL_ERROR', 'Failed to register token'), 400)

	await audit(
		db,
		actorId,
		sessionWorkspaceId,
		c.req.header('X-Workspace-Id'),
		row.createdAt.getTime() === now.getTime() ? 'created' : 'updated',
		row,
	)
	return c.json(serialize(row), 200)
})

// DELETE /api/live-activities/tokens/:id
const deleteRoute = createRoute({
	method: 'delete',
	path: '/tokens/{id}',
	tags: ['Devices'],
	summary: 'Unregister one of the caller’s ActivityKit tokens (e.g. the activity ended on-device)',
	request: { params: z.object({ id: z.string().regex(UUID_RE) }) },
	responses: {
		200: {
			description: 'Token removed',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(deleteRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const [deleted] = await db
		.delete(liveActivityTokens)
		.where(and(eq(liveActivityTokens.id, id), eq(liveActivityTokens.actorId, actorId)))
		.returning()
	if (!deleted) return c.json(createApiError('NOT_FOUND', 'Token not found'), 404)
	await audit(db, actorId, undefined, c.req.header('X-Workspace-Id'), 'deleted', deleted)
	return c.json({ deleted: true }, 200)
})

export default app
