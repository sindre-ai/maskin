import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { webPushSubscriptions } from '@maskin/db/schema'
import {
	registerWebPushSubscriptionSchema,
	webPushConfigResponseSchema,
	webPushSubscriptionResponseSchema,
} from '@maskin/shared'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { loadWebPushConfig } from '../services/web-push'
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

/** Bounds fan-out per actor: a browser profile re-subscribing forever cannot grow it unbounded. */
export const MAX_SUBSCRIPTIONS_PER_ACTOR = 20

function serialize(row: typeof webPushSubscriptions.$inferSelect) {
	// The endpoint and keys are bearer capabilities for pushing to this browser: never returned.
	return {
		id: row.id,
		actor_id: row.actorId,
		user_agent: row.userAgent,
		created_at: row.createdAt.toISOString(),
		last_seen_at: row.lastSeenAt.toISOString(),
	}
}

// Same attribution rules as device registration: per-actor data, workspace-scoped audit row.
async function audit(
	db: Database,
	actorId: string,
	header: string | undefined,
	action: 'created' | 'updated' | 'deleted',
	subscriptionId: string,
) {
	try {
		const workspaceId = await resolveAuditWorkspace(db, actorId, header)
		if (!workspaceId) return
		await recordEvent(db, {
			workspaceId,
			actorId,
			action,
			entityType: 'web_push_subscription',
			entityId: subscriptionId,
		})
	} catch (err) {
		logger.warn('web push audit event failed', { subscriptionId, error: String(err) })
	}
}

// GET /api/web-push/config
const configRoute = createRoute({
	method: 'get',
	path: '/config',
	tags: ['Web Push'],
	summary: 'Whether browser push is configured, and the VAPID public key to subscribe with',
	responses: {
		200: {
			description: 'Web Push configuration',
			content: { 'application/json': { schema: webPushConfigResponseSchema } },
		},
	},
})

app.openapi(configRoute, (c) => {
	const config = loadWebPushConfig()
	return c.json({ enabled: config !== null, public_key: config?.publicKey ?? null }, 200)
})

// POST /api/web-push/subscriptions
const subscribeRoute = createRoute({
	method: 'post',
	path: '/subscriptions',
	tags: ['Web Push'],
	summary: 'Register (or refresh) a browser push subscription for the current actor',
	description:
		'Upserts on the subscription endpoint. Re-registering an endpoint that belongs to another actor moves it to the caller.',
	request: {
		body: { content: { 'application/json': { schema: registerWebPushSubscriptionSchema } } },
	},
	responses: {
		200: {
			description: 'Subscription registered',
			content: { 'application/json': { schema: webPushSubscriptionResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(subscribeRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	// created_at is only written on insert, so it equals `now` iff the row is new.
	const now = new Date()
	const [row] = await db
		.insert(webPushSubscriptions)
		.values({
			actorId,
			endpoint: body.endpoint,
			p256dh: body.keys.p256dh,
			auth: body.keys.auth,
			userAgent: body.user_agent ?? null,
			createdAt: now,
			lastSeenAt: now,
		})
		.onConflictDoUpdate({
			target: webPushSubscriptions.endpoint,
			set: {
				actorId,
				p256dh: body.keys.p256dh,
				auth: body.keys.auth,
				userAgent: body.user_agent ?? null,
				lastSeenAt: now,
			},
		})
		.returning()

	if (!row) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to register subscription'), 400)
	}

	// Keep only the most recently seen subscriptions; the one just written is always newest.
	const mine = await db
		.select({ id: webPushSubscriptions.id })
		.from(webPushSubscriptions)
		.where(eq(webPushSubscriptions.actorId, actorId))
		.orderBy(desc(webPushSubscriptions.lastSeenAt))
	const stale = mine.slice(MAX_SUBSCRIPTIONS_PER_ACTOR).map((r) => r.id)
	if (stale.length > 0) {
		await db.delete(webPushSubscriptions).where(inArray(webPushSubscriptions.id, stale))
	}

	await audit(
		db,
		actorId,
		c.req.header('X-Workspace-Id'),
		row.createdAt.getTime() === now.getTime() ? 'created' : 'updated',
		row.id,
	)

	return c.json(serialize(row), 200)
})

// DELETE /api/web-push/subscriptions/:id
const unsubscribeRoute = createRoute({
	method: 'delete',
	path: '/subscriptions/{id}',
	tags: ['Web Push'],
	summary: 'Remove one of the current actor’s browser push subscriptions',
	request: {
		params: z.object({ id: z.string().regex(UUID_RE, 'Must be a uuid') }),
	},
	responses: {
		200: {
			description: 'Subscription removed',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
		},
		404: {
			description: 'Subscription not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(unsubscribeRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [deleted] = await db
		.delete(webPushSubscriptions)
		.where(and(eq(webPushSubscriptions.id, id), eq(webPushSubscriptions.actorId, actorId)))
		.returning()

	if (!deleted) {
		return c.json(createApiError('NOT_FOUND', 'Subscription not found'), 404)
	}

	await audit(db, actorId, c.req.header('X-Workspace-Id'), 'deleted', deleted.id)

	return c.json({ deleted: true }, 200)
})

export default app
