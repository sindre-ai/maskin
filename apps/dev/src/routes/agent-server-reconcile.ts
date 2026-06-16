import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { ApiErrorCode, createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import type { SessionManager } from '../services/session-manager'
import { SessionReconciler } from '../services/session-reconciler'

type Env = {
	Variables: {
		db: Database
		sessionManager: SessionManager
	}
}

const app = new OpenAPIHono<Env>()

const reconcileBodySchema = z.object({
	agent_server_id: z.string().uuid(),
	sandboxes: z.array(z.string().min(1)).max(10_000),
})

const reconcileResponseSchema = z.object({
	marked_failed: z.array(z.string().uuid()),
	orphan_sandboxes: z.array(z.string()),
})

const reconcileRoute = createRoute({
	method: 'post',
	path: '/reconcile',
	tags: ['Internal'],
	summary: 'Reconcile DB sessions against an agent-server sandbox snapshot',
	description:
		'Called by an agent-server on boot. The body lists every sandbox name the agent-server still has running. Any active session row whose containerId is not in that list is marked failed with reason `agent_server_lost`. The response includes orphan sandbox names the agent-server should `msb remove -f`. Authentication: `Authorization: Bearer <AGENT_SERVER_SHARED_SECRET>`.',
	request: {
		body: {
			content: {
				'application/json': {
					schema: reconcileBodySchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Reconcile pass complete',
			content: { 'application/json': { schema: reconcileResponseSchema } },
		},
		400: {
			description: 'Invalid request body',
			content: { 'application/json': { schema: errorSchema } },
		},
		401: {
			description: 'Missing or invalid bearer token',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: {
			description: 'Endpoint disabled — AGENT_SERVER_SHARED_SECRET not configured',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(reconcileRoute, async (c) => {
	const expected = process.env.AGENT_SERVER_SHARED_SECRET
	if (!expected) {
		logger.error(
			'Agent-server reconcile called but AGENT_SERVER_SHARED_SECRET is not set — refusing',
		)
		return c.json(
			createApiError(ApiErrorCode.INTERNAL_ERROR, 'Agent-server reconcile endpoint not configured'),
			503,
		)
	}

	const header = c.req.header('Authorization') ?? ''
	const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
	if (!presented || !constantTimeEqual(presented, expected)) {
		logger.warn('Agent-server reconcile rejected', {
			reason: presented ? 'wrong_token' : 'missing_token',
		})
		return c.json(createApiError(ApiErrorCode.UNAUTHORIZED, 'Invalid bearer token'), 401)
	}

	const body = c.req.valid('json')
	const db = c.get('db')
	const reconciler = new SessionReconciler(db)

	const { markedFailed, orphanSandboxes } = await reconciler.reconcile({
		agentServerId: body.agent_server_id,
		sandboxes: body.sandboxes,
	})

	return c.json(
		{
			marked_failed: markedFailed,
			orphan_sandboxes: orphanSandboxes,
		},
		200,
	)
})

const logIngestBodySchema = z.object({
	logs: z
		.array(
			z.object({
				stream: z.enum(['stdout', 'stderr', 'system']),
				content: z.string().max(65536),
			}),
		)
		.max(500),
})

const logIngestRoute = createRoute({
	method: 'post',
	path: '/sessions/:id/logs',
	tags: ['Internal'],
	summary: 'Ingest a batch of log lines from a remote agent-server session',
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: {
			content: { 'application/json': { schema: logIngestBodySchema } },
		},
	},
	responses: {
		200: {
			description: 'Logs accepted',
			content: { 'application/json': { schema: z.object({ accepted: z.number() }) } },
		},
		401: {
			description: 'Invalid bearer token',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: {
			description: 'Endpoint not configured',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(logIngestRoute, async (c) => {
	const expected = process.env.AGENT_SERVER_SHARED_SECRET
	if (!expected) {
		return c.json(
			createApiError(ApiErrorCode.INTERNAL_ERROR, 'Agent-server endpoint not configured'),
			503,
		)
	}
	const header = c.req.header('Authorization') ?? ''
	const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
	if (!presented || !constantTimeEqual(presented, expected)) {
		return c.json(createApiError(ApiErrorCode.UNAUTHORIZED, 'Invalid bearer token'), 401)
	}

	const { id } = c.req.valid('param')
	const { logs } = c.req.valid('json')
	const sessionManager = c.get('sessionManager')

	try {
		await sessionManager.appendRemoteSessionLogs(id, logs)
	} catch (err) {
		logger.error('Failed to append remote session logs', { sessionId: id, error: String(err) })
	}

	return c.json({ accepted: logs.length }, 200)
})

const sessionCompleteBodySchema = z.object({
	exitCode: z.number().int().nullable().default(null),
})

const sessionCompleteRoute = createRoute({
	method: 'post',
	path: '/sessions/:id/complete',
	tags: ['Internal'],
	summary: 'Mark a remote agent-server session as completed or failed',
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: {
			content: { 'application/json': { schema: sessionCompleteBodySchema } },
		},
	},
	responses: {
		200: {
			description: 'Session marked terminal',
			content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
		},
		401: {
			description: 'Invalid bearer token',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: {
			description: 'Endpoint not configured',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(sessionCompleteRoute, async (c) => {
	const expected = process.env.AGENT_SERVER_SHARED_SECRET
	if (!expected) {
		return c.json(
			createApiError(ApiErrorCode.INTERNAL_ERROR, 'Agent-server endpoint not configured'),
			503,
		)
	}
	const header = c.req.header('Authorization') ?? ''
	const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
	if (!presented || !constantTimeEqual(presented, expected)) {
		return c.json(createApiError(ApiErrorCode.UNAUTHORIZED, 'Invalid bearer token'), 401)
	}

	const { id } = c.req.valid('param')
	const { exitCode } = c.req.valid('json')
	const sessionManager = c.get('sessionManager')

	try {
		await sessionManager.markRemoteSessionComplete(id, exitCode)
	} catch (err) {
		logger.error('Failed to mark remote session complete', { sessionId: id, error: String(err) })
	}

	return c.json({ ok: true }, 200)
})

/** Length-leaking equality is fine here — both sides are server-controlled secrets, not user-supplied. */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let mismatch = 0
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return mismatch === 0
}

export default app
