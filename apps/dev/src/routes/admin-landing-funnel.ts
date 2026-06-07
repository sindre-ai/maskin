import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { LANDING_GUESTS_WORKSPACE_ID } from './public-bet-strategist'

// Authenticated read-only endpoint that surfaces the landing-page bet's
// kill metric (≥10% malformed drafts in any 48h window) plus the unique-guest
// count that the success metric depends on. The kill metric is computed
// purely from the `objects` table — bet_draft rows on the landing_guests
// workspace already carry `metadata.isMalformed` from T3. No new event store.
//
// The success metric (≥15% of interactors signing up within 7d) is only
// partially computable here: we can count unique guests who submitted a draft,
// but we can't join to signups without a per-actor signup_source field —
// that's T7's contract (T7 should emit a `signup_complete` landing event
// carrying the guest's anonId so the funnel closes through the log stream).
// We return the unique-guest count so the success metric can be assembled
// once the log-side signup count exists.
//
// Mounted under `/api/admin/landing-funnel`. Goes through the standard auth
// middleware in app-factory.ts.

type Env = {
	Variables: {
		db: Database
	}
}

const KILL_METRIC_THRESHOLD = 0.1
const KILL_METRIC_MIN_DRAFTS = 10 // Don't flag breached on tiny samples.

const querySchema = z.object({
	windowHours: z.coerce
		.number()
		.min(1)
		.max(24 * 30)
		.default(48),
	successWindowDays: z.coerce.number().min(1).max(60).default(7),
})

const app = new OpenAPIHono<Env>()

app.get('/', async (c) => {
	const db = c.get('db')

	const url = new URL(c.req.url)
	const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams))
	if (!parsed.success) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				'Invalid query: windowHours must be 1-720, successWindowDays must be 1-60',
			),
			400,
		)
	}
	const { windowHours, successWindowDays } = parsed.data

	const now = Date.now()
	const killSince = new Date(now - windowHours * 60 * 60 * 1000)
	const successSince = new Date(now - successWindowDays * 24 * 60 * 60 * 1000)

	const killRows = await db
		.select({
			total: sql<number>`count(*)::int`,
			malformed: sql<number>`count(*) FILTER (WHERE ${objects.metadata}->>'isMalformed' = 'true')::int`,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, LANDING_GUESTS_WORKSPACE_ID),
				eq(objects.type, 'bet_draft'),
				gte(objects.createdAt, killSince),
			),
		)

	const killRow = killRows[0] ?? { total: 0, malformed: 0 }
	const totalDrafts = Number(killRow.total)
	const malformedDrafts = Number(killRow.malformed)
	const malformedRate = totalDrafts > 0 ? malformedDrafts / totalDrafts : 0

	const guestRows = await db
		.select({
			uniqueGuests: sql<number>`count(DISTINCT ${objects.metadata}->>'guestSessionId')::int`,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, LANDING_GUESTS_WORKSPACE_ID),
				eq(objects.type, 'bet_draft'),
				gte(objects.createdAt, successSince),
			),
		)
	const uniqueGuests = Number(guestRows[0]?.uniqueGuests ?? 0)

	return c.json({
		generatedAt: new Date(now).toISOString(),
		killMetric: {
			windowHours,
			totalDrafts,
			malformedDrafts,
			malformedRate,
			threshold: KILL_METRIC_THRESHOLD,
			breached: malformedRate >= KILL_METRIC_THRESHOLD && totalDrafts >= KILL_METRIC_MIN_DRAFTS,
		},
		successMetric: {
			windowDays: successWindowDays,
			uniqueGuests,
			// Signup attribution closes through the log stream — see T7 contract
			// and the funnel-events log topic. This endpoint reports the
			// denominator only.
			signupsFromGuests: null,
			conversionRate: null,
			threshold: 0.15,
		},
	})
})

app.onError((err, c) => {
	logger.error('admin-landing-funnel: unhandled error', {
		err: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	return c.json(createApiError('INTERNAL_ERROR', 'An unexpected error occurred'), 500)
})

export default app
