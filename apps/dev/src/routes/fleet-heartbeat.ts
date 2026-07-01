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
	summary: 'Fleet-liveness heartbeat — latest session completion timestamp',
	description:
		'Called by an off-fleet Cloudflare Workers cron every ~2 minutes to detect fleet silence. Returns the most recent `sessions.completed_at` and the whole minutes elapsed since. A large or null `minutes_since` is the silence signal the worker pages Slack on. No LLM call, no MCP call, no `claude_oauth` touch — the request path must not share a failure mode with the Claude fleet. Auth: `X-Heartbeat-Secret: <HEARTBEAT_SHARED_SECRET>`.',
	responses: {
		200: {
			description: 'Heartbeat read',
			content: { 'application/json': { schema: heartbeatResponseSchema } },
		},
		401: {
			description: 'Missing or invalid heartbeat secret',
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
		logger.error('Fleet-heartbeat requested but HEARTBEAT_SHARED_SECRET is not set — refusing')
		return c.json(
			createApiError(ApiErrorCode.INTERNAL_ERROR, 'Fleet-heartbeat endpoint not configured'),
			503,
		)
	}

	const presented = c.req.header('x-heartbeat-secret') ?? ''
	// Do not include the presented value or a reason in the response — a probe
	// must not learn whether it guessed the header name, prefix, or length.
	if (!presented || !constantTimeEqual(presented, expected)) {
		return c.json(createApiError(ApiErrorCode.UNAUTHORIZED, 'Unauthorized'), 401)
	}

	const db = c.get('db')

	// A DB error thrown here propagates to the global onError handler and
	// surfaces as 5xx — the worker treats that the same as an unreachable
	// endpoint, which is the intended silence signal on DB failure.
	const rows = await db
		.select({ latest: sql<Date | string | null>`max(${sessions.completedAt})` })
		.from(sessions)

	const latest = rows[0]?.latest ?? null
	if (latest === null) {
		// Empty table (or nothing has ever completed): worker sees `null` and
		// treats it as silence. Deliberate — a fleet with zero completions is
		// indistinguishable from a fleet that has stopped completing sessions.
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

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let mismatch = 0
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return mismatch === 0
}

export default app
