import type { Database } from '@maskin/db'
import { sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { logger } from './logger'

/**
 * How long GET /api/health waits for the database before it answers 503. Kept under the
 * 5 s timeout of the Docker and Coolify health checks so they see the 503, not a timeout.
 */
export const HEALTH_DB_TIMEOUT_MS = 3_000

/**
 * GET /api/health. Answers 200 only when the app can run a query: a stall on the
 * database (pool used up, connections hung) now shows as unhealthy in Coolify
 * instead of a fixed "ok". The check runs on the same pool the requests use, so
 * a pool that is used up makes it wait and time out, which is the point.
 */
export function createHealthHandler(db: Database, timeoutMs = HEALTH_DB_TIMEOUT_MS) {
	return async (c: Context) => {
		const startedAt = Date.now()
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				db.execute(sql`SELECT 1`),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`database did not answer within ${timeoutMs} ms`)),
						timeoutMs,
					)
				}),
			])
			return c.json({ status: 'ok', timestamp: new Date().toISOString() })
		} catch (err) {
			// A warn line (not an error), so a stall leaves a trace in the container logs
			// without spending Sentry quota.
			logger.warn('Health check failed: database not answering', {
				error: String(err),
				waitedMs: Date.now() - startedAt,
			})
			return c.json({ status: 'unavailable', timestamp: new Date().toISOString() }, 503)
		} finally {
			clearTimeout(timer)
		}
	}
}
