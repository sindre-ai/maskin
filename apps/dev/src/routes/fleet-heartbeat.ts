import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'
import { ApiErrorCode, createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
	}
}

const app = new OpenAPIHono<Env>()

const heartbeatResponseSchema = z.object({
	latest_completed_at: z.string().nullable(),
	minutes_since: z.number().int().nullable(),
})

const heartbeatRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Internal'],
	summary: 'Fleet-liveness heartbeat readout for the off-fleet silence probe',
	description:
		'Returns the timestamp of the last completed session and how many minutes have elapsed since. Polled every 2 minutes by a Cloudflare Workers cron that lives on a substrate independent of the Claude fleet — if this endpoint is silent for too long (or 5xx / unreachable), the worker pages `#fleet-outages`. Authentication: `X-Heartbeat-Secret: <HEARTBEAT_SHARED_SECRET>`.',
	responses: {
		200: {
			description: 'Latest completed session read',
			content: { 'application/json': { schema: heartbeatResponseSchema } },
		},
		401: {
			description: 'Missing or invalid shared secret',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: {
			description: 'Endpoint disabled — HEARTBEAT_SHARED_SECRET not configured',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(heartbeatRoute, async (c) => {
	const expected = process.env.HEARTBEAT_SHARED_SECRET
	if (!expected) {
		logger.error('Fleet heartbeat called but HEARTBEAT_SHARED_SECRET is not set — refusing')
		return c.json(
			createApiError(ApiErrorCode.INTERNAL_ERROR, 'Fleet heartbeat endpoint not configured'),
			503,
		)
	}

	const presented = c.req.header('X-Heartbeat-Secret') ?? ''
	if (!presented || !constantTimeEqual(presented, expected)) {
		// No body detail — don't leak whether a value was tried.
		return c.json(createApiError(ApiErrorCode.UNAUTHORIZED, 'Unauthorized'), 401)
	}

	const db = c.get('db')
	// Any DB error thrown here propagates to app.onError and returns 5xx — the
	// worker treats 5xx (or unreachable) as silence, which is exactly what we
	// want when `app` itself is dead.
	const [row] = await db
		.select({ latestCompletedAt: sql<Date | null>`max(${sessions.completedAt})` })
		.from(sessions)

	const latest = row?.latestCompletedAt ?? null
	if (!latest) {
		// Empty sessions table — worker treats null/null as silence and pages
		// accordingly. This is the correct behaviour: a fleet that has never
		// completed a session is indistinguishable from a fleet that stopped.
		return c.json({ latest_completed_at: null, minutes_since: null }, 200)
	}

	const latestMs = latest instanceof Date ? latest.getTime() : new Date(latest).getTime()
	const minutesSince = Math.floor((Date.now() - latestMs) / 60_000)
	return c.json(
		{
			latest_completed_at: new Date(latestMs).toISOString(),
			minutes_since: minutesSince,
		},
		200,
	)
})

/** Length-leaking equality is fine here — both sides are server-controlled secrets, not user-supplied. */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let mismatch = 0
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return mismatch === 0
}

export default app
