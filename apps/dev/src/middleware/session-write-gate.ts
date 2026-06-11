import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { SESSION_WRITE_GATED_STATUSES, createApiError } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { logger } from '../lib/logger'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const GATED_STATUSES: ReadonlySet<string> = new Set(SESSION_WRITE_GATED_STATUSES)

/**
 * Rejects agent-attributed writes from sessions that have been stopped (or are
 * stopping) with 409. Reads `X-Maskin-Session-Id` — propagated into the agent
 * container as `MASKIN_SESSION_ID` and forwarded by the MCP HTTP client on
 * every write. The header is the contract; absence is treated as a human-driven
 * write and passes through.
 *
 * Pair with `stopSession`, which flips status → `stopping` BEFORE SIGTERM so
 * the gate is active during the SIGTERM grace window — closing the race where
 * the container fires one more `POST /api/events` between SIGTERM and exit.
 */
export function sessionWriteGate(db: Database) {
	return createMiddleware(async (c, next) => {
		const sessionId = c.req.header('X-Maskin-Session-Id')
		if (!sessionId) return next()
		// Don't trust the header blindly — a malformed value is a 400-class
		// client bug; treat as no header rather than crashing the lookup.
		if (!UUID_RE.test(sessionId)) return next()

		const [session] = await db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		// Unknown session id: don't block — the session may have been pruned,
		// or the header was fabricated. The route's own auth + workspace check
		// is the security boundary; the gate is only a stop-correctness control.
		if (!session) return next()

		if (GATED_STATUSES.has(session.status)) {
			logger.info('Session write rejected by gate', {
				sessionId,
				status: session.status,
				method: c.req.method,
				path: c.req.path,
			})
			return c.json(
				createApiError(
					'CONFLICT',
					`Session ${sessionId} is ${session.status}; further writes are blocked`,
					[{ field: 'x-maskin-session-id', message: `Session status: ${session.status}` }],
					'The user stopped or replaced this session. Stop generating and exit.',
				),
				409,
			)
		}

		return next()
	})
}
