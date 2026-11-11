import { createApiError } from '@maskin/shared'
import type { MiddlewareHandler } from 'hono'

/** Seconds a refused client is told to wait. */
export const SHED_RETRY_AFTER_S = 5

// Never refused: the health check must report the truth, webhooks and agent-server calls are
// sent by other systems that would lose data, and a refused event stream does not reconnect.
export function isExempt(path: string) {
	return (
		path === '/api/health' ||
		path === '/api/health/db' ||
		path.startsWith('/api/webhooks/') ||
		path.startsWith('/api/internal/') ||
		path === '/api/events' ||
		path.endsWith('/stream')
	)
}

/**
 * While the database is backed up, refuses new reads at once with a 503 instead of queueing
 * them. Left to queue, a burst of page loads waits up to 45 s per query, the clients give up and
 * retry, and the backlog does not drain until the server is redeployed. Refusing reads early
 * keeps the wait short, and the web app and other clients retry them. Writes and everything
 * else go through.
 *
 * `isBackedUp` must come from how long queries have really waited, not from a count: a count
 * that is wrong turns this into refusing reads from a healthy server.
 */
export function dbLoadShed(isBackedUp: () => boolean, onShed?: () => void): MiddlewareHandler {
	return async (c, next) => {
		if (c.req.method !== 'GET' || isExempt(c.req.path) || !isBackedUp()) return next()
		onShed?.()
		c.header('Retry-After', String(SHED_RETRY_AFTER_S))
		return c.json(
			createApiError('INTERNAL_ERROR', 'The server is busy. Try again in a few seconds.'),
			503,
		)
	}
}
