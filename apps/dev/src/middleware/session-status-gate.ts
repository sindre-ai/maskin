import { TERMINAL_SESSION_STATUSES, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import type { Env } from '../app-factory'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Reject writes attributed to a session that has already entered a terminal
 * state. The agent container's MCP/API client propagates the session id from
 * the `MASKIN_SESSION_ID` env var as `X-Maskin-Session-Id`. When the user
 * stops a session, status flips to `stopping` before SIGTERM — any HTTP
 * write that fires in the gap between the status flip and the container
 * actually dying is rejected here with 409. This is the gate that makes
 * stop safe: container kill alone misses the inflight write.
 *
 * Skipped when the header is absent (human-driven writes from the web app)
 * or malformed. Failures to look up the session never block the request —
 * the gate is best-effort and must not become a DB-availability dependency
 * for human writes.
 */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export const sessionStatusGate = createMiddleware<Env>(async (c, next) => {
	// Reads are not session-attributed writes — the gate is about the
	// dominant failure mode (an HTTP write firing just before SIGTERM).
	// Letting reads through during the kill window avoids breaking log
	// streaming or context fetches the agent may need to wind down cleanly.
	if (!MUTATING_METHODS.has(c.req.method)) return next()

	const sessionId = c.req.header('X-Maskin-Session-Id')
	if (!sessionId || !UUID_RE.test(sessionId)) return next()

	const db = c.get('db')
	try {
		const [session] = await db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (session && TERMINAL_SESSION_STATUSES.includes(session.status as never)) {
			logger.info('Rejected write from terminal session', {
				sessionId,
				status: session.status,
				path: c.req.path,
				method: c.req.method,
			})
			return c.json(
				createApiError(
					'CONFLICT',
					`Session ${sessionId} is ${session.status} — writes are no longer accepted`,
				),
				409,
			)
		}
	} catch (err) {
		logger.warn('Session status gate lookup failed — allowing write', {
			sessionId,
			error: String(err),
		})
	}

	return next()
})
