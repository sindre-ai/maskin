import { type Database, idempotencyRecords } from '@maskin/db'
import { eq, lt, sql } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { logger } from '../lib/logger'

const TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

let cleanupTimer: ReturnType<typeof setInterval> | null = null

function startCleanupTimer(db: Database) {
	if (cleanupTimer) return
	cleanupTimer = setInterval(async () => {
		try {
			const cutoff = new Date(Date.now() - TTL_MS)
			await db.delete(idempotencyRecords).where(lt(idempotencyRecords.createdAt, cutoff))
		} catch (err) {
			logger.warn('idempotency cleanup failed', { error: String(err) })
		}
	}, CLEANUP_INTERVAL_MS)
	cleanupTimer.unref?.()
}

/**
 * DB-backed idempotency middleware. Replaces the previous in-memory cache so
 * that a snapshotted agent session, on restore + replay, sees the same cached
 * response for the same `(actor, Idempotency-Key)` pair and does not double-
 * post comments, double-create objects, or double-send notifications.
 *
 * Fail-open semantics: a DB read or write failure does NOT block the request.
 * Worst case the dedup is lost (the same outcome as no key being sent).
 *
 * Guarantee boundary: the ledger row is written AFTER the handler runs (below),
 * so dedup is best-effort, not transactional. It reliably collapses a
 * *sequential* replay — a retry that begins after the original attempt fully
 * completed, including the ledger write. It does NOT cover two cases:
 *   1. A crash between the handler committing its side effect and the ledger
 *      INSERT landing — the replay finds no row and re-executes.
 *   2. Two concurrent requests with the same key — both miss the lookup and
 *      both run the handler; `onConflictDoUpdate` then dedups only the row,
 *      not the execution. (The retry queue is expected to serialize these.)
 * Transactional dedup would require reserving the key in the same transaction
 * as the side effect, which a generic handler-wrapping middleware can't do.
 */
export function createIdempotencyMiddleware(db: Database) {
	startCleanupTimer(db)

	return createMiddleware(async (c, next) => {
		const method = c.req.method
		if (SAFE_METHODS.has(method)) return next()

		const idempotencyKey = c.req.header('Idempotency-Key')
		if (!idempotencyKey) return next()

		const actorId = c.get('actorId') as string | undefined
		const cacheKey = `${actorId ?? 'anon'}:${idempotencyKey}`

		try {
			const [cached] = await db
				.select()
				.from(idempotencyRecords)
				.where(eq(idempotencyRecords.key, cacheKey))
				.limit(1)

			if (cached) {
				const age = Date.now() - new Date(cached.createdAt).getTime()
				// Only replay when the key was used against the SAME endpoint.
				// The cache key is scoped by actor + key but not by route, so a
				// client reusing one Idempotency-Key across different endpoints
				// would otherwise get the first endpoint's response back. Falling
				// through here re-runs the handler; the post-handler upsert then
				// overwrites the stale row for the new (method, path).
				const matchesRequest = cached.method === method && cached.path === c.req.path
				if (age <= TTL_MS && matchesRequest) {
					logger.info('idempotency hit — replaying cached response', {
						actorId,
						method,
						path: c.req.path,
					})
					return c.json(
						cached.response as Record<string, unknown>,
						cached.status as Parameters<typeof c.json>[1],
					)
				}
			}
		} catch (err) {
			logger.warn('idempotency lookup failed; passing through', { error: String(err) })
		}

		await next()

		const contentType = c.res.headers.get('content-type')
		if (!contentType?.includes('application/json')) return
		if (c.res.status >= 500) return

		try {
			const cloned = c.res.clone()
			const body = (await cloned.json()) as unknown

			await db
				.insert(idempotencyRecords)
				.values({
					key: cacheKey,
					actorId: actorId ?? null,
					method,
					path: c.req.path,
					status: cloned.status,
					response: body as Record<string, unknown>,
				})
				.onConflictDoUpdate({
					target: idempotencyRecords.key,
					set: {
						status: cloned.status,
						response: body as Record<string, unknown>,
						createdAt: sql`now()`,
					},
				})
		} catch (err) {
			logger.warn('idempotency write failed', { error: String(err) })
		}
	})
}
