import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { deviceTokens, liveActivityFollows, liveActivityTokens, sessions } from '@maskin/db/schema'
import {
	liveActivityFollowResponseSchema,
	liveActivityTokenResponseSchema,
	registerLiveActivityFollowSchema,
	registerLiveActivityTokenSchema,
} from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'
import { flushLiveActivityCard } from '../services/live-activity-push'
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
		workspace_id: row.workspaceId,
		updated_at: row.updatedAt.toISOString(),
	}
}

async function audit(
	db: Database,
	actorId: string,
	workspaceId: string | undefined,
	header: string | undefined,
	action: 'created' | 'updated' | 'deleted',
	row: { id: string },
	entityType: 'live_activity_token' | 'live_activity_follow' = 'live_activity_token',
) {
	try {
		const ws = workspaceId ?? (await resolveAuditWorkspace(db, actorId, header))
		if (!ws) return
		// Events fan out to every workspace member; record only that it happened.
		await recordEvent(db, {
			workspaceId: ws,
			actorId,
			action,
			entityType,
			entityId: row.id,
		})
	} catch (err) {
		logger.warn('live activity audit event failed', { entityType, id: row.id, error: String(err) })
	}
}

// POST /api/live-activities/tokens
const registerRoute = createRoute({
	method: 'post',
	path: '/tokens',
	tags: ['Devices'],
	summary: 'Register an ActivityKit push token (push-to-start or per-activity update)',
	description:
		"`push_to_start` is one per device and rotates (upserted on device). `update` belongs to the device's Agents working activity for the workspace in `X-Workspace-Id`; a new activity mints a new token (the old one is deleted by the app). The device must be one of the caller’s registered devices.",
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
			description: 'Device or workspace not found',
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

	// An update token belongs to the aggregate activity of one workspace, named by the header the
	// app already sends on every request. The header is also what authMiddleware checks, but this
	// route must not trust a missing one, so require it and check membership here too.
	let workspaceId: string | null = null
	if (body.kind === 'update') {
		const header = c.req.header('X-Workspace-Id')
		if (!header || !UUID_RE.test(header)) {
			return c.json(
				createApiError('BAD_REQUEST', 'X-Workspace-Id is required for update tokens'),
				400,
			)
		}
		if (!(await isWorkspaceMember(db, actorId, header))) {
			return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
		}
		workspaceId = header
	}

	const now = new Date()
	const token = body.token.toLowerCase()
	const values = {
		actorId,
		deviceId: body.device_id,
		kind: body.kind,
		token,
		workspaceId,
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
						target: [liveActivityTokens.deviceId, liveActivityTokens.token],
						targetWhere: sql`${liveActivityTokens.kind} = 'update'`,
						set: { actorId, workspaceId, updatedAt: now },
					})
					.returning()
	if (!row) return c.json(createApiError('INTERNAL_ERROR', 'Failed to register token'), 400)

	await audit(
		db,
		actorId,
		workspaceId ?? undefined,
		c.req.header('X-Workspace-Id'),
		row.createdAt.getTime() === now.getTime() ? 'created' : 'updated',
		row,
	)
	// The agents may have finished before this token existed: deliver the end (or latest state) that had nowhere to go.
	if (row.kind === 'update' && row.workspaceId) {
		await flushLiveActivityCard(actorId, row.workspaceId)
	}
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

function serializeFollow(row: typeof liveActivityFollows.$inferSelect) {
	return {
		id: row.id,
		device_id: row.deviceId,
		session_id: row.sessionId,
		workspace_id: row.workspaceId,
		updated_at: row.updatedAt.toISOString(),
	}
}

// POST /api/live-activities/follows
const followRoute = createRoute({
	method: 'post',
	path: '/follows',
	tags: ['Devices'],
	summary: 'Follow an agent run: register the push token of the card the app just started',
	description:
		'Opt-in "Following an agent" Live Activity. The app starts the card itself and sends the card\'s own push token with the `session_id` of the run being followed (workspace in `X-Workspace-Id`). The server pushes the run\'s latest step to the card while it works and a finished card when it ends, then forgets the follow. Registering again for the same device and run replaces the token. The device must be one of the caller’s registered devices.',
	request: {
		body: { content: { 'application/json': { schema: registerLiveActivityFollowSchema } } },
	},
	responses: {
		200: {
			description: 'Follow registered',
			content: { 'application/json': { schema: liveActivityFollowResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Device, run or workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(followRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	const header = c.req.header('X-Workspace-Id')
	if (!header || !UUID_RE.test(header)) {
		return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id is required to follow a run'), 400)
	}
	if (!(await isWorkspaceMember(db, actorId, header))) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	const [device] = await db
		.select({ id: deviceTokens.id })
		.from(deviceTokens)
		.where(and(eq(deviceTokens.id, body.device_id), eq(deviceTokens.actorId, actorId)))
		.limit(1)
	if (!device) return c.json(createApiError('NOT_FOUND', 'Device not found'), 404)
	const [run] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(and(eq(sessions.id, body.session_id), eq(sessions.workspaceId, header)))
		.limit(1)
	if (!run) return c.json(createApiError('NOT_FOUND', 'Run not found'), 404)

	const now = new Date()
	const [row] = await db
		.insert(liveActivityFollows)
		.values({
			actorId,
			deviceId: body.device_id,
			workspaceId: header,
			sessionId: body.session_id,
			token: body.token.toLowerCase(),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [liveActivityFollows.deviceId, liveActivityFollows.sessionId],
			set: { token: body.token.toLowerCase(), actorId, updatedAt: now },
		})
		.returning()
	if (!row) return c.json(createApiError('INTERNAL_ERROR', 'Failed to register follow'), 400)

	await audit(
		db,
		actorId,
		header,
		header,
		row.createdAt.getTime() === now.getTime() ? 'created' : 'updated',
		row,
		'live_activity_follow',
	)
	// Deliver the current step now (or the finished card, if the run ended before the token existed).
	await flushLiveActivityCard(actorId, header)
	return c.json(serializeFollow(row), 200)
})

// DELETE /api/live-activities/follows/:session_id
const unfollowRoute = createRoute({
	method: 'delete',
	path: '/follows/{session_id}',
	tags: ['Devices'],
	summary: 'Stop following an agent run on one of the caller’s devices',
	description:
		'Forgets the follow so no more updates are pushed. The app ends the card itself. Safe to repeat: `deleted` is false when there was nothing to remove.',
	request: {
		params: z.object({ session_id: z.string().regex(UUID_RE) }),
		query: z.object({ device_id: z.string().regex(UUID_RE) }),
	},
	responses: {
		200: {
			description: 'Follow removed (or already gone)',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
		},
	},
})

app.openapi(unfollowRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { session_id } = c.req.valid('param')
	const { device_id } = c.req.valid('query')
	const [deleted] = await db
		.delete(liveActivityFollows)
		.where(
			and(
				eq(liveActivityFollows.actorId, actorId),
				eq(liveActivityFollows.deviceId, device_id),
				eq(liveActivityFollows.sessionId, session_id),
			),
		)
		.returning()
	if (!deleted) return c.json({ deleted: false }, 200)
	await audit(
		db,
		actorId,
		deleted.workspaceId,
		c.req.header('X-Workspace-Id'),
		'deleted',
		deleted,
		'live_activity_follow',
	)
	return c.json({ deleted: true }, 200)
})

export default app
