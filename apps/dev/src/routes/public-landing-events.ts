import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { createApiError, validationFailureHook } from '../lib/errors'
import { LANDING_GUESTS_ACTOR_ID, LANDING_GUESTS_WORKSPACE_ID } from '../lib/landing-guests'
import { logger } from '../lib/logger'
import { extractClientIp } from '../lib/trusted-proxy'

// Public, no-auth endpoint for the landing-page funnel emitter (T8). Receives
// small batches of structured analytics events from the prompt-bar page and
// emits one `landing-event` log line per event. The log lines are the surface;
// aggregation lives in `admin-landing-funnel` (kill metric) plus log-store
// ingestion for the broader analytics signal bet.
//
// Rate limiting is per-IP, in-memory, token-bucket. We don't need cross-
// instance accuracy - the bucket is a flood guard, not a billing meter.
//
// Mounted under `/api/public/landing-events` and added to the auth allowlist
// in app-factory.ts.

type Env = {
	Variables: {
		db: Database
	}
}

// Known event names from the funnel spec. Unknown names are still accepted
// (logged with `known: false`) so the client can ship new event names ahead
// of a server deploy - but they show up as anomalies in the log stream.
export const KNOWN_LANDING_EVENTS = [
	'page_view',
	'prompt_submit',
	'draft_complete',
	'draft_malformed',
	'draft_error',
	'signup_cta_click',
	'signup_complete',
] as const

const KNOWN_LANDING_EVENT_SET: Set<string> = new Set(KNOWN_LANDING_EVENTS)

const MAX_EVENTS_PER_REQUEST = 20
const MAX_PROPS_BYTES = 2_000

const eventSchema = z.object({
	name: z.string().min(1).max(64),
	ts: z.string().datetime().optional(),
	anonId: z.string().min(8).max(128),
	sessionId: z.string().min(8).max(128).optional(),
	props: z.record(z.unknown()).optional(),
})

const bodySchema = z.object({
	events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
})

// Per-IP token bucket. 60 events/min sustained; small headroom for the
// initial page_view burst plus event-stream completions.
const BUCKET_CAPACITY = 120
const BUCKET_REFILL_PER_MS = 60 / (60 * 1000) // 60 tokens / minute

type Bucket = { tokens: number; lastSeen: number }
const buckets = new Map<string, Bucket>()

// Cap the map so a hostile attacker can't grow it without bound. When the
// map exceeds the cap we drop the oldest 10% by insertion order - Map's
// iteration order is insertion order in JS, so the head is the oldest entry.
const BUCKET_MAP_CAP = 10_000

function takeTokens(ip: string, count: number, now: number): boolean {
	const existing = buckets.get(ip)
	let tokens = BUCKET_CAPACITY
	if (existing) {
		const elapsed = now - existing.lastSeen
		tokens = Math.min(BUCKET_CAPACITY, existing.tokens + elapsed * BUCKET_REFILL_PER_MS)
	}
	if (tokens < count) {
		buckets.set(ip, { tokens, lastSeen: now })
		return false
	}
	buckets.set(ip, { tokens: tokens - count, lastSeen: now })
	if (buckets.size > BUCKET_MAP_CAP) {
		const drop = Math.floor(BUCKET_MAP_CAP * 0.1)
		let i = 0
		for (const key of buckets.keys()) {
			if (i++ >= drop) break
			buckets.delete(key)
		}
	}
	return true
}

// Test-only reset to clear the per-IP bucket between cases.
export function _resetLandingEventBuckets(): void {
	buckets.clear()
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

app.post('/', async (c) => {
	let body: z.infer<typeof bodySchema>
	try {
		const raw = await c.req.json()
		const parsed = bodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					`Body must be { events: [{ name, anonId, ... }] }; 1-${MAX_EVENTS_PER_REQUEST} events per batch`,
				),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	const socketIp = (c.req.raw as unknown as { remoteAddress?: string }).remoteAddress
	const ip = extractClientIp(socketIp, c.req.header('X-Forwarded-For'))
	const ua = c.req.header('User-Agent') ?? null
	const now = Date.now()

	if (!takeTokens(ip, body.events.length, now)) {
		logger.info('landing-events: throttled', { ip, eventCount: body.events.length })
		c.header('Retry-After', '60')
		return c.json(
			createApiError('RATE_LIMITED', 'Too many landing events in the last minute.'),
			429,
		)
	}

	for (const ev of body.events) {
		// Defensive cap on props size so a chatty client can't bloat log lines.
		let props: unknown = ev.props
		if (props !== undefined) {
			try {
				const serialized = JSON.stringify(props)
				if (serialized.length > MAX_PROPS_BYTES) {
					props = { __truncated: true, originalBytes: serialized.length }
				}
			} catch {
				props = { __unserializable: true }
			}
		}

		logger.info('landing-event', {
			name: ev.name,
			known: KNOWN_LANDING_EVENT_SET.has(ev.name),
			anonId: ev.anonId,
			sessionId: ev.sessionId,
			ts: ev.ts ?? new Date(now).toISOString(),
			props,
			ip,
			ua,
		})

		if (ev.name === 'signup_complete') {
			const db = c.get('db')
			try {
				const existing = await db
					.select({ id: objects.id })
					.from(objects)
					.where(
						and(
							eq(objects.workspaceId, LANDING_GUESTS_WORKSPACE_ID),
							eq(objects.type, 'landing_signup'),
							sql`${objects.metadata}->>'anonId' = ${ev.anonId}`,
						),
					)
					.limit(1)

				if (existing.length === 0) {
					await db.insert(objects).values({
						workspaceId: LANDING_GUESTS_WORKSPACE_ID,
						type: 'landing_signup',
						status: 'done',
						createdBy: LANDING_GUESTS_ACTOR_ID,
						metadata: { anonId: ev.anonId, props: ev.props ?? null },
					})
				}
			} catch (dbErr) {
				logger.error('landing-events: failed to persist signup_complete', {
					err: dbErr instanceof Error ? dbErr.message : String(dbErr),
					anonId: ev.anonId,
				})
			}
		}
	}

	return c.body(null, 204)
})

app.onError((err, c) => {
	logger.error('landing-events: unhandled error', {
		err: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	return c.json(createApiError('INTERNAL_ERROR', 'An unexpected error occurred'), 500)
})

export default app
