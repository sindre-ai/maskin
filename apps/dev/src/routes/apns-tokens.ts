import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { apnsDeviceTokens } from '@maskin/db/schema'
import { apnsTokenResponseSchema, registerApnsTokenBodySchema } from '@maskin/shared'
import { validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// PATCH /api/apns-tokens — upsert the caller's APNs device token.
//
// The iOS Tauri shell kicks OS-side `registerForRemoteNotifications` on every
// launch (initIosPushNotifications in apps/web/src/lib/ios-push.ts). Whenever
// APNs returns a token, the shell PATCHes it here so the backend can address
// this specific device for push delivery. Idempotent by token: repeated boots
// with the same token just bump `updated_at`; a rotated token inserts a new
// row (the old one stays until either the actor is deleted — cascades — or a
// server-side sender learns from APNs that it's stale and reaps it).
//
// If the same physical device is signed in as a different actor after
// sign-out, the token conflict re-assigns `actor_id` to the new owner. That
// keeps a stale sign-in from receiving pushes on somebody else's iPhone.
const registerRoute = createRoute({
	method: 'patch',
	path: '/',
	tags: ['APNs Tokens'],
	summary: 'Register (upsert) the caller’s APNs device token',
	request: {
		body: {
			content: { 'application/json': { schema: registerApnsTokenBodySchema } },
		},
	},
	responses: {
		200: {
			description: 'Token registered',
			content: { 'application/json': { schema: apnsTokenResponseSchema } },
		},
	},
})

app.openapi(registerRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { token, environment } = c.req.valid('json')

	const [row] = await db
		.insert(apnsDeviceTokens)
		.values({ actorId, token, environment })
		.onConflictDoUpdate({
			target: apnsDeviceTokens.token,
			set: { actorId, environment, updatedAt: new Date() },
		})
		.returning()

	if (!row) {
		throw new Error('Upsert returned no row')
	}

	logger.info('apns device token registered', {
		actorId,
		environment,
		// Log the last 8 chars only — the full token is a delivery secret.
		tokenSuffix: token.slice(-8),
	})

	return c.json(
		{
			id: row.id,
			token: row.token,
			environment: row.environment,
			created_at: row.createdAt.toISOString(),
			updated_at: row.updatedAt.toISOString(),
		},
		200,
	)
})

export default app
