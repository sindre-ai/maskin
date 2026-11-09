import type { InFlight } from '@maskin/db'
import { createApiError } from '@maskin/shared'
import type { MiddlewareHandler } from 'hono'

/** Seconds a refused client is told to wait. */
export const SHED_RETRY_AFTER_S = 5

// Never refused: the health check must report the truth, webhooks and agent-server calls are
// sent by other systems that would lose data, and a refused event stream does not reconnect.
function isExempt(path: string) {
	return (
		path === '/api/health' ||
		path.startsWith('/api/webhooks/') ||
		path.startsWith('/api/internal/') ||
		path === '/api/events' ||
		path.endsWith('/stream')
	)
}

/**
 * Once more than `limit` database queries are waiting, refuses new reads at once with a 503
 * instead of queueing them. Left to queue, a burst of page loads waits up to 45 s per query,
 * the clients give up and retry, and the backlog (about 1,500 queries in the 2026-11-09
 * incidents) never drains until the server is redeployed. Refusing reads early keeps the wait
 * short, and the web app and other clients retry them. Writes and everything else go through.
 */
export function dbLoadShed(load: InFlight, limit: number, onShed?: () => void): MiddlewareHandler {
	return async (c, next) => {
		if (c.req.method !== 'GET' || load.count <= limit || isExempt(c.req.path)) return next()
		onShed?.()
		c.header('Retry-After', String(SHED_RETRY_AFTER_S))
		return c.json(
			createApiError('INTERNAL_ERROR', 'The server is busy. Try again in a few seconds.'),
			503,
		)
	}
}
