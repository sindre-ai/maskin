import type { Database } from '@maskin/db'
import { sessionLogs, sessions } from '@maskin/db/schema'
import {
	createSessionSchema,
	sessionLogQuerySchema,
	sessionParamsSchema,
	sessionQuerySchema,
} from '@maskin/shared'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createApiError } from '../lib/errors'
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

const app = new OpenAPIHono<Env>()

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
	const sessionId = c.req.param('id')
	const workspaceId = c.req.header('x-workspace-id')
	const lastLogId = c.req.header('Last-Event-ID')

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

	const terminalStatuses = ['completed', 'failed', 'timeout']

	return streamSSE(c, async (stream) => {
		// Check if session is already in terminal state
		const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)

		if (session && terminalStatuses.includes(session.status)) {
			// Replay all logs for completed sessions, then close
			const allLogs = await db
				.select()
				.from(sessionLogs)
				.where(eq(sessionLogs.sessionId, sessionId))
				.orderBy(asc(sessionLogs.id))

			for (const log of allLogs) {
				await stream.writeSSE({
					id: String(log.id),
					event: log.stream,
					data: log.content,
				})
			}
			await stream.writeSSE({ event: 'done', data: session.status })
			return
		}

		// Replay missed logs if Last-Event-ID is provided
		const parsedLogId = Number(lastLogId)
		if (lastLogId && !Number.isNaN(parsedLogId)) {
			const missed = await db
				.select()
				.from(sessionLogs)
				.where(and(eq(sessionLogs.sessionId, sessionId), gt(sessionLogs.id, parsedLogId)))
				.orderBy(asc(sessionLogs.id))
				.limit(500)

			for (const log of missed) {
				await stream.writeSSE({
					id: String(log.id),
					event: log.stream,
					data: log.content,
				})
			}
		}

		// Subscribe to live log stream
		let closed = false
		const handler = (event: SessionLogEvent) => {
			if (event.sessionId !== sessionId) return
			stream.writeSSE({
				id: String(event.logId),
				event: event.stream,
				data: event.data,
			})

			// Close stream when session completes (system log signals completion)
			if (event.stream === 'system' && event.data.startsWith('Session completed')) {
				closed = true
				stream.writeSSE({ event: 'done', data: 'completed' })
			}
			if (event.stream === 'system' && event.data.startsWith('Session failed')) {
				closed = true
				stream.writeSSE({ event: 'done', data: 'failed' })
			}
		}

		sessionManager.on('log', handler)
		stream.onAbort(() => {
			sessionManager.off('log', handler)
		})

		// Keep connection alive, but stop if session reached terminal state
		while (!closed) {
			await stream.sleep(30000)
		}
	})
})

export default app
