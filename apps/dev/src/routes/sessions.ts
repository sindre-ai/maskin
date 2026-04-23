import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { sessionLogs, sessions } from '@maskin/db/schema'
import {
	createSessionSchema,
	sessionInputSchema,
	sessionLogQuerySchema,
	sessionParamsSchema,
	sessionQuerySchema,
} from '@maskin/shared'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createApiError, formatZodError } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	errorSchema,
	sessionLogResponseSchema,
	sessionResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import type { SessionLogEvent, SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: SessionManager
	}
}

const app = new OpenAPIHono<Env>({
	defaultHook: (result, c) => {
		if (!result.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Request validation failed',
					formatZodError(result.error),
				),
				400,
			)
		}
		return undefined
	},
})

/** Load a session and verify it belongs to the caller's workspace. */
async function loadSessionWithAuth(db: Database, sessionId: string, workspaceId: string) {
	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.workspaceId, workspaceId)))
		.limit(1)
	return session ?? null
}

// POST / - Create session
const createSessionRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Sessions'],
	summary: 'Create and optionally start a session',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: createSessionSchema } },
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: sessionResponseSchema } },
			description: 'Session created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(createSessionRoute, (async (c) => {
	const sessionManager = c.get('sessionManager')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await sessionManager.createSession(workspaceId, {
		actorId: body.actor_id,
		actionPrompt: body.action_prompt,
		config: body.config,
		triggerId: body.trigger_id,
		createdBy: actorId,
		autoStart: body.auto_start,
	})

	return c.json(serialize(session) as z.infer<typeof sessionResponseSchema>, 201)
}) as RouteHandler<typeof createSessionRoute, Env>)

// GET / - List sessions
const listSessionsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Sessions'],
	summary: 'List sessions',
	request: {
		headers: workspaceIdHeader,
		query: sessionQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(sessionResponseSchema) } },
			description: 'List of sessions',
		},
	},
})

app.openapi(listSessionsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const conditions = [eq(sessions.workspaceId, workspaceId)]
	if (query.status) conditions.push(eq(sessions.status, query.status))
	if (query.actor_id) conditions.push(eq(sessions.actorId, query.actor_id))

	const results = await db
		.select()
		.from(sessions)
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(desc(sessions.createdAt))

	return c.json(serializeArray(results) as z.infer<typeof sessionResponseSchema>[])
}) as RouteHandler<typeof listSessionsRoute, Env>)

// GET /:id - Get session detail
const getSessionRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Sessions'],
	summary: 'Get session details',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: sessionResponseSchema } },
			description: 'Session details',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(getSessionRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	return c.json(serialize(session) as z.infer<typeof sessionResponseSchema>)
}) as RouteHandler<typeof getSessionRoute, Env>)

// POST /:id/stop - Stop a running session
const stopSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/stop',
	tags: ['Sessions'],
	summary: 'Stop a running session',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: sessionResponseSchema } },
			description: 'Session stopped',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot stop session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(stopSessionRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	try {
		await sessionManager.stopSession(id)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}

	const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	return c.json(serialize(updated) as z.infer<typeof sessionResponseSchema>)
}) as RouteHandler<typeof stopSessionRoute, Env>)

// POST /:id/pause - Pause and snapshot a session
const pauseSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/pause',
	tags: ['Sessions'],
	summary: 'Pause a running session and save snapshot',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: sessionResponseSchema } },
			description: 'Session paused',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot pause session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(pauseSessionRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	try {
		await sessionManager.pauseSession(id)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}

	const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	return c.json(serialize(updated) as z.infer<typeof sessionResponseSchema>)
}) as RouteHandler<typeof pauseSessionRoute, Env>)

// POST /:id/resume - Resume a paused session
const resumeSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/resume',
	tags: ['Sessions'],
	summary: 'Resume a paused session from snapshot',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: sessionResponseSchema } },
			description: 'Session resumed',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot resume session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(resumeSessionRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	try {
		await sessionManager.resumeSession(id)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}

	const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	return c.json(serialize(updated) as z.infer<typeof sessionResponseSchema>)
}) as RouteHandler<typeof resumeSessionRoute, Env>)

// POST /:id/input - Send a user turn to an interactive session
const inputSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/input',
	tags: ['Sessions'],
	summary: 'Send a user input turn to an interactive session',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		body: {
			content: { 'application/json': { schema: sessionInputSchema } },
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
			description: 'Input accepted',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not interactive or not running',
		},
	},
})

app.openapi(inputSessionRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	if (!session.interactive) {
		return c.json(createApiError('CONFLICT', 'Session is not interactive'), 409)
	}
	if (session.status !== 'running') {
		return c.json(
			createApiError('CONFLICT', `Session is not running (status: ${session.status})`),
			409,
		)
	}

	try {
		await sessionManager.writeInput(id, {
			type: 'user',
			message: { role: 'user', content: body.content },
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}

	return c.json({ ok: true as const })
}) as RouteHandler<typeof inputSessionRoute, Env>)

// GET /:id/logs - Paginated log history
const getSessionLogsRoute = createRoute({
	method: 'get',
	path: '/{id}/logs',
	tags: ['Sessions'],
	summary: 'Get session log history',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		query: sessionLogQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(sessionLogResponseSchema) } },
			description: 'Session logs',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(getSessionLogsRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	const conditions = [eq(sessionLogs.sessionId, id)]
	if (query.since) conditions.push(gt(sessionLogs.id, query.since))
	if (query.stream) conditions.push(eq(sessionLogs.stream, query.stream))

	const results = await db
		.select()
		.from(sessionLogs)
		.where(and(...conditions))
		.limit(query.limit)
		.orderBy(asc(sessionLogs.id))

	return c.json(serializeArray(results) as z.infer<typeof sessionLogResponseSchema>[])
}) as RouteHandler<typeof getSessionLogsRoute, Env>)

// GET /:id/logs/stream - SSE stream of live logs
app.get('/:id/logs/stream', async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const rawSessionId = c.req.param('id')
	const workspaceId = c.req.header('x-workspace-id')
	const lastLogId = c.req.header('Last-Event-ID')

	// Reject non-UUID session ids up front — passing a malformed string into
	// the DB query produces a Postgres "invalid input syntax for type uuid"
	// that surfaces as an uncaught 500.
	const parsedParams = sessionParamsSchema.safeParse({ id: rawSessionId })
	if (!parsedParams.success) {
		return c.json(
			createApiError('BAD_REQUEST', 'Invalid session id', [
				{ field: 'id', message: 'Must be a UUID', expected: 'UUID string' },
			]),
			400,
		)
	}
	const sessionId = parsedParams.data.id

	if (!workspaceId) {
		return c.json(
			createApiError('BAD_REQUEST', 'Missing x-workspace-id header', [
				{ field: 'x-workspace-id', message: 'Required header is missing', expected: 'UUID string' },
			]),
			400,
		)
	}

	// Verify session belongs to workspace
	const authSession = await loadSessionWithAuth(db, sessionId, workspaceId)
	if (!authSession) {
		return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	}

	// Include 'paused' so a client subscribing to an already-paused session
	// receives replay + done instead of hanging in the keep-alive loop below.
	const terminalStatuses = ['completed', 'failed', 'timeout', 'paused']

	const parsedLogId = Number(lastLogId)
	const resumeFromLogId =
		lastLogId && Number.isFinite(parsedLogId) && parsedLogId >= 0 ? parsedLogId : null

	return streamSSE(c, async (stream) => {
		// Emit a terminal `done` frame with an id strictly greater than any log id
		// the client has seen, so a reconnect's Last-Event-ID will skip past it and
		// the dedup ring can recognize it on replay.
		const emitDone = async (status: string, lastSeenLogId: number) => {
			await stream.writeSSE({
				id: String(lastSeenLogId + 1),
				event: 'done',
				data: status,
			})
		}

		// Check if session is already in terminal state
		const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)

		if (session && terminalStatuses.includes(session.status)) {
			// Replay logs the client has not yet seen, capped at 500, then close.
			const replayConds = [eq(sessionLogs.sessionId, sessionId)]
			if (resumeFromLogId !== null) replayConds.push(gt(sessionLogs.id, resumeFromLogId))
			const replayed = await db
				.select()
				.from(sessionLogs)
				.where(and(...replayConds))
				.orderBy(asc(sessionLogs.id))
				.limit(500)

			let maxLogId = resumeFromLogId ?? 0
			for (const log of replayed) {
				await stream.writeSSE({
					id: String(log.id),
					event: log.stream,
					data: log.content,
				})
				if (log.id > maxLogId) maxLogId = log.id
			}
			await emitDone(session.status, maxLogId)
			return
		}

		// Replay missed logs if Last-Event-ID is provided
		let maxLogId = resumeFromLogId ?? 0
		if (resumeFromLogId !== null) {
			const missed = await db
				.select()
				.from(sessionLogs)
				.where(and(eq(sessionLogs.sessionId, sessionId), gt(sessionLogs.id, resumeFromLogId)))
				.orderBy(asc(sessionLogs.id))
				.limit(500)

			for (const log of missed) {
				await stream.writeSSE({
					id: String(log.id),
					event: log.stream,
					data: log.content,
				})
				if (log.id > maxLogId) maxLogId = log.id
			}
		}

		// Resolver that wakes the heartbeat loop the moment a terminal frame is written.
		let resolveClosed: (() => void) | null = null
		const closedPromise = new Promise<void>((resolve) => {
			resolveClosed = resolve
		})
		let closed = false
		const markClosed = () => {
			if (closed) return
			closed = true
			resolveClosed?.()
		}

		// Maps a system-log prefix to the `done` payload to emit when a session
		// reaches that terminal state. Using prefix matching because log content
		// may include trailing detail (e.g. "Session completed with exit code 0").
		const TERMINAL_SYSTEM_LOGS: Array<{ prefix: string; done: string }> = [
			{ prefix: 'Session completed', done: 'completed' },
			{ prefix: 'Session failed', done: 'failed' },
			{ prefix: 'Session timed out', done: 'timeout' },
			{ prefix: 'Session paused', done: 'paused' },
		]

		// Subscribe to live log stream
		const handler = (event: SessionLogEvent) => {
			if (event.sessionId !== sessionId) return
			if (event.logId > maxLogId) maxLogId = event.logId
			// writeSSE returns a Promise. We're in an event listener (sync) so
			// we can't await it — but we must attach an error handler to avoid
			// unhandled rejections when the client disconnects mid-write or
			// backpressure propagates a socket error. Dropped writes are not
			// recoverable here; just log and detach so we stop trying.
			const emit = async () => {
				await stream.writeSSE({
					id: String(event.logId),
					event: event.stream,
					data: event.data,
				})
				if (event.stream === 'system') {
					const terminal = TERMINAL_SYSTEM_LOGS.find((t) => event.data.startsWith(t.prefix))
					if (terminal) {
						await emitDone(terminal.done, maxLogId)
						markClosed()
					}
				}
			}
			emit().catch((err) => {
				sessionManager.off('log', handler)
				logger.warn('SSE log write failed; detaching listener', {
					err: err instanceof Error ? err.message : String(err),
					sessionId,
				})
				markClosed()
			})
		}

		sessionManager.on('log', handler)
		stream.onAbort(() => {
			sessionManager.off('log', handler)
			markClosed()
		})

		// Heartbeat: write an SSE comment every 15s so idle-timeout proxies don't
		// drop the connection. Comment frames are ignored by compliant SSE
		// parsers. The race on closedPromise wakes the loop immediately when the
		// session terminates, so we don't keep the socket open for up to 15s
		// after the `done` frame.
		while (!closed && !stream.aborted && !stream.closed) {
			await Promise.race([stream.sleep(15000), closedPromise])
			if (closed || stream.aborted || stream.closed) break
			await stream.write(': keepalive\n\n')
		}
	})
})

export default app
