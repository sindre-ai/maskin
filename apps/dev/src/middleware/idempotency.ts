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
				if (age <= TTL_MS) {
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
