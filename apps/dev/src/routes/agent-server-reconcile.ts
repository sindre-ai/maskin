import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { ApiErrorCode, createApiError, validationFailureHook } from '../lib/errors'
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

// Mounted into the main app via `app.route(...)` in app-factory.ts, but a
// route's `defaultHook` binds to whichever OpenAPIHono instance `.openapi()`
// was called on — `.route()` mounting does not inherit the parent's hook.
// Passed explicitly here so a validation failure on this internal (agent-
// server-to-apps/dev) route is actually logged; see validationFailureHook's
// own comment in lib/errors.ts.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

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
		'Called by an agent-server on boot. The body lists every sandbox name the agent-server still has running. Any active session row whose containerId is not in that list is marked failed with reason `agent_server_lost`. The response includes orphan sandbox names the agent-server should `msb remove -f`. Authentication: `Authorization: Bearer <AGENT_SERVER_SECRET>`.',
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
			description: 'Endpoint disabled — AGENT_SERVER_SECRET not configured',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(reconcileRoute, async (c) => {
	const expected = process.env.AGENT_SERVER_SECRET
	if (!expected) {
		logger.error('Agent-server reconcile called but AGENT_SERVER_SECRET is not set — refusing')
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

// Per-line content cap. `session_logs.content` (packages/db/src/schema.ts)
// is an unbounded `text` column, so this exists purely as a network-input
// sanity ceiling (see .claude/rules/input-validation.md) — not a real
// storage constraint. Previously capped at 64KB, which coding-agent CLIs
// routinely exceeded with a single NDJSON stdout line (a full tool result,
// large diff, base64 image) that has no embedded newline, silently dropping
// the entire batch it was part of. See
// docs/runbooks/agent-session-failures-2026-08-11.md, Issue 1. Raised well
// above realistic tool-output sizes — the agent-server client additionally
// truncates any line over 60KB before sending (MAX_LOG_LINE_BYTES in
// apps/agent-server/src/index.ts), so a real line should never approach this;
// it's a backstop against a buggy or compromised client, not a size we
// expect to hit.
const MAX_LOG_LINE_BYTES = 1_048_576 // 1MB

const logLineSchema = z.object({
	stream: z.enum(['stdout', 'stderr', 'system']),
	content: z.string().max(MAX_LOG_LINE_BYTES),
})

// The array-item `content` field is intentionally left unbounded at this
// OpenAPI/Hono request-validation layer (no `.max()`) so a single oversized
// line can't fail schema validation and drop the ENTIRE batch (up to 500
// lines) with one 400. The real per-line cap (MAX_LOG_LINE_BYTES, via
// logLineSchema) is instead enforced manually per-item inside the handler
// below, so only the offending line is rejected — every other line in the
// batch still gets stored. See docs/runbooks/agent-session-failures-2026-08-11.md,
// Issue 1 ("make batch validation partial-failure-tolerant").
const logIngestBodySchema = z.object({
	logs: z
		.array(
			z.object({
				stream: z.enum(['stdout', 'stderr', 'system']),
				content: z.string(),
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
			description:
				'Logs accepted (a partial batch may have some lines rejected — see `accepted` count)',
			content: { 'application/json': { schema: z.object({ accepted: z.number() }) } },
		},
		400: {
			description: 'Every line in the batch failed per-line validation',
			content: { 'application/json': { schema: errorSchema } },
		},
		401: {
			description: 'Invalid bearer token',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description:
				'Failed to persist the batch — the caller should retry the same lines rather than treat them as delivered',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: {
			description: 'Endpoint not configured',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(logIngestRoute, async (c) => {
	const expected = process.env.AGENT_SERVER_SECRET
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

	// Partial-failure-tolerant: validate each line individually against the
	// real per-line cap (MAX_LOG_LINE_BYTES) instead of rejecting the whole
	// batch when one line is oversized. See the comment on logIngestBodySchema
	// above for why the array-level schema doesn't already enforce this.
	const validLogs: Array<{ stream: 'stdout' | 'stderr' | 'system'; content: string }> = []
	const rejected: Array<{ index: number; issues: string[] }> = []
	logs.forEach((line, index) => {
		const parsed = logLineSchema.safeParse(line)
		if (parsed.success) {
			validLogs.push(parsed.data)
		} else {
			rejected.push({ index, issues: parsed.error.issues.map((issue) => issue.message) })
		}
	})

	if (rejected.length > 0) {
		logger.warn('Rejected oversized log line(s) in remote session log batch', {
			sessionId: id,
			rejectedCount: rejected.length,
			acceptedCount: validLogs.length,
			maxLineBytes: MAX_LOG_LINE_BYTES,
			rejected,
		})
	}

	// Every line in the batch failed — there's nothing to store, so this is a
	// genuine validation failure worth surfacing as a 400 rather than a silent
	// no-op 200.
	if (logs.length > 0 && validLogs.length === 0) {
		return c.json(
			createApiError(
				ApiErrorCode.VALIDATION_ERROR,
				'All log lines in batch failed validation',
				rejected.map((r) => ({
					field: `logs[${r.index}].content`,
					message: r.issues.join('; '),
					expected: `string, max ${MAX_LOG_LINE_BYTES} bytes`,
				})),
			),
			400,
		)
	}

	try {
		await sessionManager.appendRemoteSessionLogs(id, validLogs)
	} catch (err) {
		// Must not report success here: previously this caught-and-continued to
		// a 200 with `accepted: validLogs.length` regardless of whether the
		// batch actually made it into session_logs — the agent-server's
		// flushLogs() then treated the batch as delivered and discarded it,
		// even though a DB failure partway through appendRemoteSessionLogs's
		// per-line insert loop can leave some or all lines unpersisted. This is
		// exactly the kind of silent log loss this PR exists to fix. A 500
		// routes into flushLogs()'s existing retry loop instead — some already-
		// persisted lines from this batch may be re-inserted on retry, which is
		// an acceptable duplication tradeoff against permanent, invisible loss.
		logger.error('Failed to append remote session logs', { sessionId: id, error: String(err) })
		return c.json(createApiError(ApiErrorCode.INTERNAL_ERROR, 'Failed to persist log batch'), 500)
	}

	return c.json({ accepted: validLogs.length }, 200)
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
	const expected = process.env.AGENT_SERVER_SECRET
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
