import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { deviceTokens, workspaceMembers } from '@maskin/db/schema'
import { deviceResponseSchema, registerDeviceSchema } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function serializeDevice(row: typeof deviceTokens.$inferSelect) {
	return {
		id: row.id,
		actor_id: row.actorId,
		platform: row.platform as z.infer<typeof deviceResponseSchema>['platform'],
		environment: row.environment as z.infer<typeof deviceResponseSchema>['environment'],
		app_version: row.appVersion,
		created_at: row.createdAt.toISOString(),
		last_seen_at: row.lastSeenAt.toISOString(),
	}
}

// Device registration is per-actor, not per-workspace, but `events` rows are
// workspace-scoped. Attribute the audit row to the caller's `X-Workspace-Id`
// (membership already enforced by authMiddleware) or, when absent, to the
// actor's first workspace. An actor in no workspace gets no audit row.
async function resolveAuditWorkspace(db: Database, actorId: string, header: string | undefined) {
	if (header && UUID_RE.test(header)) return header
	const [member] = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, actorId))
		.limit(1)
	return member?.workspaceId
}

async function auditDevice(
	db: Database,
	actorId: string,
	header: string | undefined,
	action: 'created' | 'updated' | 'deleted',
	row: typeof deviceTokens.$inferSelect,
) {
	try {
		const workspaceId = await resolveAuditWorkspace(db, actorId, header)
		if (!workspaceId) return
		// Events fan out to every workspace member over SSE/history, but a device
		// belongs to one actor. Record only that it happened (entity id + action);
		// platform / environment / app_version / token stay in `device_tokens`.
		await recordEvent(db, {
			workspaceId,
			actorId,
			action,
			entityType: 'device',
			entityId: row.id,
		})
	} catch (err) {
		logger.warn('device audit event failed', { deviceId: row.id, error: String(err) })
	}
}

// POST /api/devices
const registerDeviceRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Devices'],
	summary: 'Register (or refresh) a push device for the current actor',
	description:
		'Upserts on (apns_token, environment). Re-registering a token that belongs to another actor moves it to the caller.',
	request: {
		body: { content: { 'application/json': { schema: registerDeviceSchema } } },
	},
	responses: {
		200: {
			description: 'Device registered',
			content: { 'application/json': { schema: deviceResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(registerDeviceRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	// created_at is only written on insert, so it equals `now` iff the row is new.
	const now = new Date()
	const [row] = await db
		.insert(deviceTokens)
		.values({
			actorId,
			platform: body.platform,
			apnsToken: body.apns_token.toLowerCase(),
			environment: body.environment,
			appVersion: body.app_version ?? null,
			createdAt: now,
			lastSeenAt: now,
		})
		.onConflictDoUpdate({
			target: [deviceTokens.apnsToken, deviceTokens.environment],
			set: {
				actorId,
				platform: body.platform,
				appVersion: body.app_version ?? null,
				lastSeenAt: now,
			},
		})
		.returning()

	if (!row) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to register device'), 400)
	}

	await auditDevice(
		db,
		actorId,
		c.req.header('X-Workspace-Id'),
		row.createdAt.getTime() === now.getTime() ? 'created' : 'updated',
		row,
	)

	return c.json(serializeDevice(row), 200)
})

// DELETE /api/devices/:id_or_token
const deleteDeviceRoute = createRoute({
	method: 'delete',
	path: '/{id_or_token}',
	tags: ['Devices'],
	summary: 'Unregister one of the current actor’s push devices',
	description:
		'Prefer the device id (uuid) returned by POST /api/devices. The raw APNs token is also accepted for compatibility, but it is a credential in a URL path — clients should delete by id. Only the owner can delete.',
	request: {
		params: z.object({ id_or_token: z.string().min(1).max(512) }),
	},
	responses: {
		200: {
			description: 'Device removed',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
		},
		404: {
			description: 'Device not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deleteDeviceRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id_or_token } = c.req.valid('param')

	const match = UUID_RE.test(id_or_token)
		? eq(deviceTokens.id, id_or_token)
		: eq(deviceTokens.apnsToken, id_or_token.toLowerCase())

	const [deleted] = await db
		.delete(deviceTokens)
		.where(and(match, eq(deviceTokens.actorId, actorId)))
		.returning()

	if (!deleted) {
		return c.json(createApiError('NOT_FOUND', 'Device not found'), 404)
	}

	await auditDevice(db, actorId, c.req.header('X-Workspace-Id'), 'deleted', deleted)

	return c.json({ deleted: true }, 200)
})

export default app
