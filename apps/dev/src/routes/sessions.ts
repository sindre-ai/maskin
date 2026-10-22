import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, messages, sessionLogs, sessions, triggers } from '@maskin/db/schema'
import {
	MULTI_INSTALL_PROVIDERS,
	SESSION_ACTIVITY_SCAN_ROWS,
	createSessionSchema,
	formatComputerRequestAsMarkdown,
	formatIntegrationConnectAsMarkdown,
	formatKeychainAccessRequestAsMarkdown,
	formatKeychainRequestAsMarkdown,
	formatQuestionsAsMarkdown,
	getSessionQuerySchema,
	sessionActivityQuerySchema,
	sessionActivityResponseSchema,
	sessionAskSchema,
	sessionComputerCardSchema,
	sessionConnectCardSchema,
	sessionInputSchema,
	sessionKeychainAccessCardSchema,
	sessionKeychainCardSchema,
	sessionLeanRowSchema,
	sessionLogQuerySchema,
	sessionLogsDeepQuerySchema,
	sessionParamsSchema,
	sessionQuerySchema,
	sessionUsageQuerySchema,
	sessionUsageResponseSchema,
} from '@maskin/shared'
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { resolveAgentAccess } from '../lib/integrations/agent-access'
import { describeAgentAccess } from '../lib/integrations/agent-access-view'
import { refuseRawSecret } from '../lib/integrations/raw-secret-backstop'
import { listProviders } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import {
	errorSchema,
	sessionLogResponseSchema,
	sessionNotifyResponseSchema,
	sessionResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { canControlSession, canReadSession, helperAskConversationId } from '../lib/session-access'
import { loadSessionActivity } from '../lib/session-activity-query'
import { redactSessionConfig } from '../lib/session-config-redaction'
import { assertWorkspaceWriterRole, isWorkspaceWriter } from '../lib/workspace-auth'
import { humanParticipants, notifyAgentQuestion } from '../services/chat-notifications'
import { returnsToChatByDefault } from '../services/chat-origin-routing'
import { ensureChiefOfStaffChat, resolveAskTargetHuman } from '../services/chief-of-staff-chat'
import { insertConversationMessage } from '../services/conversation-messages'
import { resolveSpawnLink } from '../services/helper-link'
import { type HelperReturnOutcome, returnToSender } from '../services/helper-return'
import { TERMINAL_STATUSES, startSession } from '../services/session-lifecycle'
import type { SessionLogEvent, SessionManager } from '../services/session-manager'
import {
	canAnchorToMessage,
	isConversationParticipant,
	resolveAskConversationId,
} from '../services/spawned-sessions'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: SessionManager
		maskinSessionId?: string
		workspaceRole?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/**
 * Keep-alive interval for the session log stream. Kept below the 60s idle
 * timeout common to reverse proxies, and below the web client's silence
 * watchdog in `apps/web/src/lib/sse.ts`.
 */
const SSE_HEARTBEAT_MS = 15_000

/**
 * Session row for an HTTP response. The stored config can hold env_vars values
 * and mcps env / headers values, so those are masked here, in the one place every
 * session-returning handler goes through. Internal readers use the raw row.
 */
function serializeSession<T extends { config: unknown } & Record<string, unknown>>(session: T) {
	return serialize({ ...session, config: redactSessionConfig(session.config) })
}

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
	'x-viewer-policy': 'writer',
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Stash entry_agent_role inside the existing config JSON blob so downstream
	// analytics (parent bet's Chief of Staff thinness query) can attribute
	// every session to the agent that received the owner's first turn without
	// requiring an additive column migration.
	// Also record who asked (create_session lands here), so launch can
	// tell the helper who sent it without rewriting the stored action prompt.
	const baseConfig = {
		...body.config,
		...(body.entry_agent_role ? { entry_agent_role: body.entry_agent_role } : {}),
		sent_by_actor_id: actorId,
	}

	// Link the new session to the one that started it, so its outcome can be sent
	// back. The session id comes from the X-Maskin-Session-Id header, which is a
	// claim and not proof: it only counts when it is the authenticated caller's own
	// live session in this workspace (see resolveSpawnLink).
	const link = await resolveSpawnLink(db, {
		claimedSessionId: c.get('maskinSessionId'),
		authenticatedActorId: actorId,
		workspaceId,
		objectId: body.initiated_from_object_id ?? null,
	})
	// notify_on_complete only means something with a link: with no sender to
	// return to, the flag is dropped rather than stored.
	// A helper started from inside a chat is interactive by default, so it can ask
	// the person a question; it ends the moment it returns its result (see
	// InteractiveTurnFinalizer). `ask_conversation_id` is where its questions go —
	// kept in config rather than on `conversation_id`, so the helper is not a chat
	// participant's session (no capacity exemption, no per-chat uniqueness).
	const askConversationId =
		link.linked && body.interactive !== false
			? await resolveAskConversationId(db, link.spawnedBySessionId)
			: null
	// A helper started from a chat returns into that chat unless the caller said
	// otherwise: when the sender is in a 1-1 chat,
	// notify_on_complete defaults on (helper-return.ts then prefers the chat to the
	// object). An explicit true or false from the caller always wins.
	const notifyOnComplete =
		body.notify_on_complete ??
		(link.linked &&
			(await returnsToChatByDefault(db, {
				senderSessionId: link.spawnedBySessionId,
				senderConversationId: link.senderConversationId,
				creatorId: actorId,
				workspaceId,
			})))
	const config = link.linked
		? {
				...baseConfig,
				...(askConversationId
					? { interactive: true, stop_on_result: true, ask_conversation_id: askConversationId }
					: {}),
				hop_depth: link.hopDepth,
				// The chat this work belongs to, read by the chat-origin routing
				// and by session_origin (chat-origin-routing.ts).
				...(link.originConversationId ? { origin_conversation_id: link.originConversationId } : {}),
				...(notifyOnComplete ? { notify_on_complete: true } : {}),
			}
		: baseConfig

	// A caller-named anchor message is a claim too: honour it only for a chat the
	// caller is in, otherwise this session's prompt would surface in someone
	// else's conversation. Dropped (not rejected) so a bad id never blocks the work.
	let spawnedByMessageId = body.spawned_by_message_id
	if (
		spawnedByMessageId !== undefined &&
		!(await canAnchorToMessage(db, { messageId: spawnedByMessageId, workspaceId, actorId }))
	) {
		logger.warn('Ignoring spawned_by_message_id the caller cannot anchor to', {
			message_id: spawnedByMessageId,
			actor_id: actorId,
			workspace_id: workspaceId,
		})
		spawnedByMessageId = undefined
	}

	const handle = await startSession({
		workspaceId,
		actorId: body.actor_id,
		callerKind: 'rest',
		actionPrompt: body.action_prompt,
		config,
		triggerId: body.trigger_id,
		createdBy: actorId,
		autoStart: body.auto_start,
		parentSessionId: body.source_session_id,
		spawnedBySessionId: link.linked ? link.spawnedBySessionId : undefined,
		initiatedFromObjectId: body.initiated_from_object_id ?? null,
		await: 'none',
		spawnedByMessageId,
		dependsOnSessionIds: body.depends_on_session_ids,
	})

	// startSession returns a lightweight handle plus the underlying row on a
	// fresh insert. On an idempotency hit the row is absent — fetch it then.
	let session = handle.session
	if (!session) {
		const [row] = await db.select().from(sessions).where(eq(sessions.id, handle.sessionId)).limit(1)
		if (!row) {
			throw new Error(`Session ${handle.sessionId} vanished immediately after startSession`)
		}
		session = row
	}
	const created = serializeSession(session) as z.infer<typeof sessionResponseSchema>
	// The work still runs when the chain is too deep; the caller is told nothing
	// will be sent back, so it does not wait for a return that cannot come.
	if (!link.linked && link.reason === 'hop_cap') {
		return c.json({ ...created, spawnLinkDropped: 'hop_cap' }, 201)
	}
	return c.json(created, 201)
}) as RouteHandler<typeof createSessionRoute, Env>)

/**
 * Trim `actionPrompt` down to a scannable title for the lean-row shape.
 * ~60 chars matches the sidebar row width in the v2 mockup; the ellipsis
 * signals truncation for prompts that ran long.
 */
const SESSION_TITLE_MAX_CHARS = 60
function synthesizeSessionTitle(row: {
	id: string
	triggerName: string | null
	actionPrompt: string | null
}): string {
	if (row.triggerName && row.triggerName.trim().length > 0) return row.triggerName
	const prompt = row.actionPrompt?.trim()
	if (prompt && prompt.length > 0) {
		return prompt.length > SESSION_TITLE_MAX_CHARS
			? `${prompt.slice(0, SESSION_TITLE_MAX_CHARS - 1).trimEnd()}…`
			: prompt
	}
	return `Session ${row.id.slice(0, 8)}`
}

// GET / - List sessions
const listSessionsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Sessions'],
	summary: 'List sessions (lean by default; pass verbose=true for the full shape)',
	request: {
		headers: workspaceIdHeader,
		query: sessionQuerySchema,
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.union([z.array(sessionResponseSchema), z.array(sessionLeanRowSchema)]),
				},
			},
			description:
				'List of sessions. Lean rows { id, title, status, updated_at } by default; full session rows when verbose=true.',
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
	if (query.trigger_id) conditions.push(eq(sessions.triggerId, query.trigger_id))
	if (query.mention_object_id) {
		// Match both @mention-triggered sessions and thread-reply auto-trigger
		// sessions for this object so the UI can attach a live activity card
		// under either kind of triggering comment in a single query.
		conditions.push(
			sql`(${sessions.config}->'mention'->>'object_id' = ${query.mention_object_id} OR ${sessions.config}->'thread_reply'->>'object_id' = ${query.mention_object_id})`,
		)
	}
	if (query.conversation_id) {
		// Conversation-triggered sessions (see conversation-responder.ts) —
		// lets the UI show a "this agent is responding" indicator for a
		// conversation the same way mention_object_id does for object comments.
		//
		// Filters on the denormalized `sessions.conversation_id` column (backfilled
		// in 0053, written by createSession) so it hits sessions_conversation_actor_idx
		// instead of scanning every row's JSONB path — an open chat polls this.
		conditions.push(eq(sessions.conversationId, query.conversation_id))
	}
	// Half-open contract — Zod has already validated these as ISO-8601 strings.
	if (query.updated_before) conditions.push(lt(sessions.updatedAt, new Date(query.updated_before)))
	if (query.updated_after) conditions.push(gt(sessions.updatedAt, new Date(query.updated_after)))
	if (query.before) conditions.push(lt(sessions.updatedAt, new Date(query.before)))

	if (query.verbose) {
		// Same order as the lean path: the `before` cursor filters on updated_at, so a
		// created_at sort skips or repeats rows when a caller walks pages with it.
		//
		// Ordering by updated_at lets the planner walk sessions_ws_updated_at_idx and
		// filter conversation_id row by row. An open chat polls this query, so for a
		// conversation the filter runs in a fenced subquery (the explicit `offset 0`
		// stops Postgres from folding it into the outer sort) and keeps
		// sessions_conversation_actor_idx as its access path.
		if (query.conversation_id) {
			const filtered = db
				.select()
				.from(sessions)
				.where(and(...conditions))
				// Drizzle drops a literal `.offset(0)` and types offset as a number, so pass
				// the raw SQL fragment through the number slot to get `offset 0` emitted.
				.offset(sql`0` as unknown as number)
				.as('conversation_sessions')
			const fenced = await db
				.select()
				.from(filtered)
				.orderBy(desc(filtered.updatedAt), desc(filtered.id))
				.limit(query.limit)
				.offset(query.offset)

			return c.json(fenced.map(serializeSession) as z.infer<typeof sessionResponseSchema>[])
		}

		const results = await db
			.select()
			.from(sessions)
			.where(and(...conditions))
			.limit(query.limit)
			.offset(query.offset)
			.orderBy(desc(sessions.updatedAt), desc(sessions.id))

		return c.json(results.map(serializeSession) as z.infer<typeof sessionResponseSchema>[])
	}

	// Lean path: LEFT JOIN triggers for title synthesis (the trigger's name is
	// preferred over the raw actionPrompt when the session was scheduled). Every
	// column touched here is already indexed — sessions_ws_status_idx covers
	// workspace filtering, triggerId is a FK, and the JOIN is one row per
	// session because triggerId is a single uuid column.
	const leanRows = await db
		.select({
			id: sessions.id,
			status: sessions.status,
			updatedAt: sessions.updatedAt,
			actionPrompt: sessions.actionPrompt,
			triggerName: triggers.name,
		})
		.from(sessions)
		.leftJoin(triggers, eq(sessions.triggerId, triggers.id))
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		// Ordered by updated_at (not created_at) because the `before` cursor filters
		// on updated_at: any other sort order skips or repeats rows across pages.
		.orderBy(desc(sessions.updatedAt), desc(sessions.id))

	const shaped = leanRows.map((row) => ({
		id: row.id,
		title: synthesizeSessionTitle({
			id: row.id,
			triggerName: row.triggerName,
			actionPrompt: row.actionPrompt,
		}),
		status: row.status,
		updated_at: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
	}))

	return c.json(shaped as z.infer<typeof sessionLeanRowSchema>[])
}) as RouteHandler<typeof listSessionsRoute, Env>)

// GET /usage - Aggregated cost & token usage for an agent over time
// Registered before /{id} so the static `usage` segment wins the match.
const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 366
const MAX_HOURLY_RANGE_DAYS = 60

const sessionUsageRoute = createRoute({
	method: 'get',
	path: '/usage',
	tags: ['Sessions'],
	summary: 'Aggregate session cost & token usage for an agent',
	request: {
		headers: workspaceIdHeader,
		query: sessionUsageQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: sessionUsageResponseSchema } },
			description: 'Bucketed usage and totals',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid range or bucket',
		},
	},
})

app.openapi(sessionUsageRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { actor_id: actorId, from, to, bucket } = c.req.valid('query')

	const fromDate = new Date(from)
	const toDate = new Date(to)
	const fromMs = fromDate.getTime()
	const toMs = toDate.getTime()

	if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
		return c.json(createApiError('VALIDATION_ERROR', '`to` must be after `from`'), 400)
	}
	const spanDays = (toMs - fromMs) / DAY_MS
	if (spanDays > MAX_RANGE_DAYS) {
		return c.json(
			createApiError('VALIDATION_ERROR', `Range may not exceed ${MAX_RANGE_DAYS} days`),
			400,
		)
	}
	if (bucket === 'hour' && spanDays > MAX_HOURLY_RANGE_DAYS) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				`Hourly bucket only supported for ranges up to ${MAX_HOURLY_RANGE_DAYS} days`,
			),
			400,
		)
	}

	// Pass timestamps as ISO strings + ::timestamptz cast — some poolers
	// (e.g. Supabase pgbouncer in transaction mode) can't serialize JS Date
	// values and throw `ERR_INVALID_ARG_TYPE`.
	const fromIso = fromDate.toISOString()
	const toIso = toDate.toISOString()

	const rows = (await db.execute(sql`
		SELECT
			date_trunc(${bucket}, completed_at AT TIME ZONE 'UTC') AS bucket,
			COUNT(*)::int AS session_count,
			COALESCE(SUM(total_cost_usd), 0)::float8 AS total_cost_usd,
			COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
			COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
			COALESCE(
				SUM(COALESCE(cache_creation_input_tokens, 0) + COALESCE(cache_read_input_tokens, 0)),
				0
			)::bigint AS cache_tokens
		FROM sessions
		WHERE workspace_id = ${workspaceId}
			AND actor_id = ${actorId}
			AND completed_at IS NOT NULL
			AND completed_at >= ${fromIso}::timestamptz
			AND completed_at <  ${toIso}::timestamptz
		GROUP BY 1
		ORDER BY 1 ASC
	`)) as unknown as Array<{
		bucket: Date | string
		session_count: number
		total_cost_usd: number
		// bigint sums arrive from postgres.js as strings; Number() below converts
		// them back (exact below 2^53).
		input_tokens: number | string
		output_tokens: number | string
		cache_tokens: number | string
	}>

	const buckets = rows.map((r) => ({
		bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
		session_count: Number(r.session_count),
		total_cost_usd: Number(r.total_cost_usd),
		input_tokens: Number(r.input_tokens),
		output_tokens: Number(r.output_tokens),
		cache_tokens: Number(r.cache_tokens),
	}))

	const totals = buckets.reduce(
		(acc, b) => {
			acc.session_count += b.session_count
			acc.total_cost_usd += b.total_cost_usd
			acc.input_tokens += b.input_tokens
			acc.output_tokens += b.output_tokens
			acc.cache_tokens += b.cache_tokens
			return acc
		},
		{
			session_count: 0,
			total_cost_usd: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_tokens: 0,
		},
	)

	return c.json({ buckets, totals })
}) as RouteHandler<typeof sessionUsageRoute, Env>)

// GET /:id - Get session detail
const getSessionResponseSchema = sessionResponseSchema.extend({
	// Present only when the caller passed include_logs=true. Ordered newest-first
	// (id DESC) so the ending — where a failure lives — is at index 0.
	logs: z.array(sessionLogResponseSchema).optional(),
})

const getSessionRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Sessions'],
	summary: 'Get session details',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		query: getSessionQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: getSessionResponseSchema } },
			description: 'Session details',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session is private to the person who started it',
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
	const { include_logs, log_limit } = c.req.valid('query')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (!(await canReadSession(db, session, c.get('actorId'), c.get('workspaceRole')))) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	const serialized = serializeSession(session) as z.infer<typeof sessionResponseSchema>

	if (!include_logs) {
		return c.json(serialized as z.infer<typeof getSessionResponseSchema>)
	}

	// Newest-first tail, honoring log_limit. Response order is id DESC (NOT
	// reversed) so the failure lands at index 0. Serves the same slice as the
	// dedicated /logs/deep endpoint, so callers who only want a peek at the
	// tail can skip the second round trip.
	const logRows = await db
		.select()
		.from(sessionLogs)
		.where(eq(sessionLogs.sessionId, id))
		.orderBy(desc(sessionLogs.id))
		.limit(log_limit)

	return c.json({
		...serialized,
		logs: serializeArray(logRows) as z.infer<typeof sessionLogResponseSchema>[],
	} as z.infer<typeof getSessionResponseSchema>)
}) as RouteHandler<typeof getSessionRoute, Env>)

/**
 * The flag arrived after the helper ended (create_session with wait: true sets it at poll timeout, and
 * the helper can finish in the gap). Nothing else will fire the return, so do it
 * here. If the end-of-session return already ran and was skipped only because the
 * sender was live, give the one-shot claim back so the flag gets its turn.
 * Returns null while the helper is still running (the end-of-session return picks
 * the flag up), otherwise what the return did.
 */
async function returnIfAlreadyEnded(
	db: Database,
	session: typeof sessions.$inferSelect,
	sessionManager: SessionManager,
): Promise<HelperReturnOutcome | null> {
	if (!session.spawnedBySessionId) return { returned: false, reason: 'no_link' }
	if (!(TERMINAL_STATUSES as readonly string[]).includes(session.status)) return null
	if (session.helperReturnedAt) {
		const [skipped] = await db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.entityType, 'session'),
					eq(events.entityId, session.id),
					eq(events.action, 'helper_return_skipped'),
					sql`${events.data}->>'reason' = 'sender_live'`,
				),
			)
			.limit(1)
		if (!skipped) return { returned: false, reason: 'already_returned' }
		await db.update(sessions).set({ helperReturnedAt: null }).where(eq(sessions.id, session.id))
	}
	return returnToSender(db, session.id, { sessionManager })
}

// PATCH /:id - Update mutable session fields (agents call this to record active step)
const updateSessionSchema = z
	.object({
		current_activity: z.string().max(500).nullable().optional(),
		// create_session (wait: true) sets this when its poll times out: "send me the result later".
		// It only ever turns the flag on.
		notify_on_complete: z.literal(true).optional(),
	})
	.refine((b) => b.current_activity !== undefined || b.notify_on_complete !== undefined, {
		message: 'Provide current_activity or notify_on_complete',
	})

const patchSessionRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	'x-viewer-policy': 'writer',
	tags: ['Sessions'],
	summary: 'Update mutable session fields',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		body: {
			content: { 'application/json': { schema: updateSessionSchema } },
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: sessionNotifyResponseSchema } },
			description: 'Session updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(patchSessionRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	// Only whoever started the helper can ask for its result to come back.
	if (body.notify_on_complete && session.createdBy !== actorId) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	// With no spawn link there is nobody to send the result to. Saying so beats
	// storing a flag that can never fire and answering OK (create drops it too).
	if (body.notify_on_complete && !session.spawnedBySessionId) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Session has no spawn link, so there is no sender to return its result to',
			),
			400,
		)
	}

	const [updated] = await db
		.update(sessions)
		.set({
			updatedAt: new Date(),
			...(body.current_activity !== undefined ? { currentActivity: body.current_activity } : {}),
			...(body.notify_on_complete
				? {
						config: sql`coalesce(${sessions.config}, '{}'::jsonb) || '{"notify_on_complete": true}'::jsonb`,
					}
				: {}),
		})
		.where(eq(sessions.id, id))
		.returning()

	if (!updated) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	const notifyOutcome = body.notify_on_complete
		? await returnIfAlreadyEnded(db, updated, c.get('sessionManager'))
		: undefined

	await recordEvent(db, {
		workspaceId,
		actorId: session.actorId,
		action: 'session_updated',
		entityType: 'session',
		entityId: id,
		data: {},
	})

	logger.info('Session current_activity updated', { sessionId: id })

	// What happened to the return, so the caller knows whether to keep waiting.
	// null/undefined outcome with the flag set = helper still running: registered.
	const notify = !body.notify_on_complete
		? {}
		: !notifyOutcome
			? { notify_on_complete: 'registered' as const }
			: notifyOutcome.returned
				? { notify_on_complete: 'delivered' as const }
				: { notify_on_complete: 'skipped' as const, notify_skip_reason: notifyOutcome.reason }

	return c.json({
		...serializeSession(updated),
		...notify,
	} as z.infer<typeof sessionNotifyResponseSchema>)
}) as RouteHandler<typeof patchSessionRoute, Env>)

// POST /:id/stop - Stop a running session
const stopSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/stop',
	'x-viewer-policy': 'writer',
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
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller did not start this session and is not a workspace admin',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(stopSessionRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (!(await canControlSession(db, session, c.get('actorId'), c.get('workspaceRole')))) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	try {
		await sessionManager.stopSession(id)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}

	const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	return c.json(serializeSession(updated) as z.infer<typeof sessionResponseSchema>)
}) as RouteHandler<typeof stopSessionRoute, Env>)

// POST /:id/pause - Pause and snapshot a session
const pauseSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/pause',
	'x-viewer-policy': 'writer',
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
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller did not start this session and is not a workspace admin',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(pauseSessionRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (!(await canControlSession(db, session, c.get('actorId'), c.get('workspaceRole')))) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	try {
		await sessionManager.pauseSession(id)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}

	const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	return c.json(serializeSession(updated) as z.infer<typeof sessionResponseSchema>)
}) as RouteHandler<typeof pauseSessionRoute, Env>)

// POST /:id/resume - Resume a paused session
const resumeSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/resume',
	'x-viewer-policy': 'writer',
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
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller did not start this session and is not a workspace admin',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(resumeSessionRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (!(await canControlSession(db, session, c.get('actorId'), c.get('workspaceRole')))) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	try {
		await sessionManager.resumeSession(id)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}

	const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	return c.json(serializeSession(updated) as z.infer<typeof sessionResponseSchema>)
}) as RouteHandler<typeof resumeSessionRoute, Env>)

// POST /:id/input - Send a user turn to an interactive session
const inputSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/input',
	'x-viewer-policy': 'writer',
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
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller did not start this session',
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
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	// The turn is written as the session's user, so only whoever started the
	// session may add one. Checked before the state gates so a stranger learns
	// nothing about whether it is running.
	// A helper that asks its questions in a chat takes the answer from anyone in
	// that chat, not only the agent that started it.
	const askConversationId = helperAskConversationId(session)
	if (session.createdBy !== actorId) {
		const inAskChat = askConversationId
			? await isConversationParticipant(db, askConversationId, actorId)
			: false
		if (!inAskChat) {
			return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
		}
	}

	if (!session.interactive) {
		return c.json(createApiError('CONFLICT', 'Session is not interactive'), 409)
	}
	if (session.status !== 'running') {
		return c.json(
			createApiError('CONFLICT', `Session is not running (status: ${session.status})`),
			409,
		)
	}

	// Keychain backstop; the turn goes straight to the agent's stdin and into the chat.
	const secretRefusal = await refuseRawSecret(db, {
		content: body.content,
		workspaceId,
		actorId,
		actorType: c.get('actorType'),
		entityType: 'session',
		entityId: id,
	})
	if (secretRefusal) return c.json(secretRefusal, 400)

	try {
		await sessionManager.writeInput(
			id,
			{
				type: 'user',
				message: { role: 'user', content: body.content },
			},
			body.attachments,
		)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}

	// The answer to a helper's question: clear the wait, and put the person's
	// reply in the chat so the question there reads as answered. Inserted
	// directly rather than through POST /messages — that would wake the chat's
	// own agents with an answer meant for someone else.
	if (askConversationId && session.config && (session.config as { awaiting?: unknown }).awaiting) {
		await db
			.update(sessions)
			.set({ config: sql`${sessions.config} - 'awaiting'` })
			.where(eq(sessions.id, id))
		if (body.question_answer) {
			await insertConversationMessage(db, {
				conversationId: askConversationId,
				workspaceId,
				actorId,
				content: body.content,
				metadata: { question_answer: body.question_answer },
				sessionId: null,
			}).catch((err) =>
				logger.warn('Could not record the answer to a helper question in the chat', {
					session_id: id,
					error: String(err),
				}),
			)
		}
	}

	return c.json({ ok: true as const })
}) as RouteHandler<typeof inputSessionRoute, Env>)

// POST /:id/continue - Carry on with a helper that has already ended
//
// A helper in a chat ends the moment it gives its result, so there is nothing to
// type into. This starts a new interactive session for the same agent that stays
// open, hangs it from the same message so it is another thread of the same chat,
// and tells it what it did before and what the person now says. The person's
// follow-up is its first turn; the thread then takes messages like any live one.
const continueSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/continue',
	'x-viewer-policy': 'writer',
	tags: ['Sessions'],
	summary: 'Start a follow-up session for a helper that has ended',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		body: { content: { 'application/json': { schema: sessionInputSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: z.object({ session_id: z.string().uuid() }) } },
			description: 'Follow-up session started',
		},
		400: { content: { 'application/json': { schema: errorSchema } }, description: 'Refused' },
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller is not in the chat this session belongs to',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session has not ended',
		},
	},
})

app.openapi(continueSessionRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	// Whoever started it, or anyone in a chat it belongs to: the one it asks its questions in,
	// the one it came from, or the one holding the message it was handed off from.
	if (session.createdBy !== actorId) {
		const cfg = (session.config ?? {}) as { origin_conversation_id?: unknown }
		const chatIds = new Set<string>()
		const ask = helperAskConversationId(session)
		if (ask) chatIds.add(ask)
		if (typeof cfg.origin_conversation_id === 'string') chatIds.add(cfg.origin_conversation_id)
		if (session.conversationId) chatIds.add(session.conversationId)
		if (session.spawnedByMessageId) {
			const [anchor] = await db
				.select({ conversationId: messages.conversationId })
				.from(messages)
				.where(eq(messages.id, session.spawnedByMessageId))
				.limit(1)
			if (anchor) chatIds.add(anchor.conversationId)
		}
		let entitled = false
		for (const chatId of chatIds) {
			if (await isConversationParticipant(db, chatId, actorId)) {
				entitled = true
				break
			}
		}
		if (!entitled) {
			return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
		}
	}
	if (!(TERMINAL_STATUSES as readonly string[]).includes(session.status)) {
		return c.json(createApiError('CONFLICT', 'Session has not ended: write into it instead'), 409)
	}

	const secretRefusal = await refuseRawSecret(db, {
		content: body.content,
		workspaceId,
		actorId,
		actorType: c.get('actorType'),
		entityType: 'session',
		entityId: id,
	})
	if (secretRefusal) return c.json(secretRefusal, 400)

	// The person's words are the session's prompt, as in any chat: that is what its first
	// message and its title show. What the agent did before reaches it through the system
	// prompt at launch (config.continues_*), not through this text.
	const earlier = (session.actionPrompt ?? '').trim().slice(0, 600)
	const actionPrompt = body.content.trim()

	const origin = (session.config ?? {}) as { origin_conversation_id?: unknown; hop_depth?: unknown }
	const config = {
		interactive: true,
		// Ends after its reply, like the helper it continues, so the thread reads Done between
		// messages; the next message starts the next follow-up.
		stop_on_result: true,
		sent_by_actor_id: actorId,
		continues_session_id: id,
		continues_chain: [
			...(Array.isArray((session.config as { continues_chain?: unknown } | null)?.continues_chain)
				? ((session.config as { continues_chain: unknown[] }).continues_chain.filter(
						(x) => typeof x === 'string',
					) as string[])
				: []),
			id,
		],
		continues_prompt: earlier,
		...(helperAskConversationId(session)
			? { ask_conversation_id: helperAskConversationId(session) }
			: {}),
		...(typeof origin.origin_conversation_id === 'string'
			? { origin_conversation_id: origin.origin_conversation_id }
			: {}),
		...(typeof origin.hop_depth === 'number' ? { hop_depth: origin.hop_depth } : {}),
	}
	const handle = await startSession({
		workspaceId,
		actorId: session.actorId,
		callerKind: 'rest',
		actionPrompt,
		config,
		createdBy: actorId,
		initiatedFromObjectId: session.initiatedFromObjectId,
		await: 'none',
		// Another thread of the same chat: the anchor message when there is one, else the
		// chat session that started the original.
		spawnedByMessageId: session.spawnedByMessageId ?? undefined,
		spawnedBySessionId: session.spawnedByMessageId
			? undefined
			: (session.spawnedBySessionId ?? undefined),
	})
	return c.json({ session_id: handle.sessionId }, 201)
}) as RouteHandler<typeof continueSessionRoute, Env>)

// POST /:id/ask - Surface an agent's AskUserQuestion into the chat it is in
//
// The headless CLI cannot render AskUserQuestion (it has no TTY), so it fails
// the call outright — which is how a live session lost a reply on 2026-08-25.
// The in-container PreToolUse hook intercepts the call and posts it here
// instead, then tells the agent to end its turn; the human's answer comes back
// as an ordinary chat message through the existing conversation responder.
//
// This is deliberately available ONLY to interactive sessions attached to a
// conversation. A trigger-driven or otherwise autonomous session has nobody on
// the other end: pausing it on a question would strand the run until the
// timeout backstop, so it gets a 409 telling the agent to decide for itself.
// The gate lives here rather than in the hook because the container knows only
// its INTERACTIVE env var, while the conversation attachment is a server-side
// fact that can change after launch.
const askSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/ask',
	'x-viewer-policy': 'writer',
	tags: ['Sessions'],
	summary: "Post an agent's question into its chat conversation",
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		body: { content: { 'application/json': { schema: sessionAskSchema } } },
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						message_id: z.number(),
						posted: z.literal(true),
						// 'chief_of_staff' means the answer goes to the Chief of Staff's chat,
						// not back into this session, so the agent must not wait for it.
						delivered_to: z.enum(['chat', 'chief_of_staff']),
					}),
				},
			},
			description: 'Question posted to the conversation',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller does not own this session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session is not an interactive chat session',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Question could not be persisted',
		},
	},
})

app.openapi(askSessionRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { questions } = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	// The question is posted as the agent, so only the agent running this
	// session may ask — otherwise any workspace member's key could put a
	// question in another agent's name.
	if (session.actorId !== actorId) {
		return c.json(createApiError('FORBIDDEN', 'Session belongs to a different actor'), 403)
	}

	// A chat session asks in its own conversation; a helper another agent started
	// asks in the one it was started from. Anything else (a trigger-driven run, a
	// session started from the sessions UI) asks in the person's 1-1 with the
	// Chief of Staff, so every question lands in one thread.
	let conversationId = session.conversationId ?? helperAskConversationId(session)
	let deliveredTo: 'chat' | 'chief_of_staff' = 'chat'
	let cosHumanId: string | null = null
	if (!conversationId) {
		const humanId = await resolveAskTargetHuman(db, session.workspaceId, session.createdBy)
		cosHumanId = humanId
		const cosChat = humanId ? await ensureChiefOfStaffChat(db, session.workspaceId, humanId) : null
		if (cosChat) {
			conversationId = cosChat.conversationId
			deliveredTo = 'chief_of_staff'
		}
	}
	if (!conversationId || (deliveredTo === 'chat' && !session.interactive)) {
		return c.json(
			createApiError(
				'CONFLICT',
				'Session is not an interactive chat session, so there is no human to ask',
			),
			409,
		)
	}

	const isHelper = deliveredTo === 'chat' && !session.conversationId
	const created = await insertConversationMessage(db, {
		conversationId,
		workspaceId: session.workspaceId,
		actorId: session.actorId,
		content: formatQuestionsAsMarkdown(questions),
		metadata: {
			question: {
				session_id: session.id,
				questions,
				...(isHelper ? { reply_to_session: true } : {}),
			},
		},
		sessionId: session.id,
	})

	// insertConversationMessage returns null only when a unique constraint
	// suppressed the insert. This caller carries no dedupe key, so there is no
	// conflict it can legitimately lose — null means something unexpected fired
	// and the question is gone. It must NOT return 409: that is the status the
	// hook reads as "expected, autonomous session, stay quiet", which would bury
	// a real fault in the one branch nobody investigates.
	if (!created) {
		logger.error('Agent question insert returned no row', {
			sessionId: session.id,
			conversationId,
			questionCount: questions.length,
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Question could not be posted'), 500)
	}

	// A helper is now waiting on the person. The flag keeps the session alive
	// through the turn that ends with this question (see InteractiveTurnFinalizer)
	// and is what the Threads pane shows as "waiting on you".
	if (isHelper) {
		await db
			.update(sessions)
			.set({
				config: sql`jsonb_set(coalesce(${sessions.config}, '{}'::jsonb), '{awaiting}', ${JSON.stringify(
					{ message_id: created.id, question: { session_id: session.id, questions } },
				)}::jsonb)`,
			})
			.where(eq(sessions.id, session.id))
	}

	// Push the person: an agent is blocked on them. Recipients: for the Chief of
	// Staff 1-1 it is the resolved human (the 1-1's only human); otherwise every
	// active human in the conversation the question was posted to, because that
	// chat -- not session.createdBy, which for a helper is the asking agent and
	// for a chat session is whoever sent the first message -- is where the
	// answer will be read. Best effort and after the post: it never alters the
	// response.
	try {
		const askTargets =
			deliveredTo === 'chief_of_staff' && cosHumanId
				? [cosHumanId]
				: await humanParticipants(db, conversationId, session.actorId)
		await notifyAgentQuestion(db, {
			workspaceId: session.workspaceId,
			agentId: session.actorId,
			conversationId,
			messageId: created.id,
			targets: askTargets,
			firstQuestion: questions[0]?.question ?? '',
			objectId: session.initiatedFromObjectId,
			sessionId: session.id,
		})
	} catch (err) {
		logger.warn('Failed to notify the person about an agent question', {
			sessionId: session.id,
			conversationId,
			messageId: created.id,
			error: String(err),
		})
	}

	logger.info('Posted agent question into conversation', {
		sessionId: session.id,
		conversationId,
		messageId: created.id,
		questionCount: questions.length,
	})

	return c.json({ message_id: created.id, posted: true as const, delivered_to: deliveredTo })
}) as RouteHandler<typeof askSessionRoute, Env>)

// POST /:id/connect-card - Surface a "connect this integration" card in the chat
//
// Called by the `connect_integration` MCP tool when it runs inside a chat
// session. The human finishes the connection in the card — an OAuth button, or
// an input for an API key — so a credential never passes through the model and
// the agent never has to paste a URL. Same gates as /ask: only the agent that
// owns an interactive chat session may post, and anything else gets a 409 so the
// tool can fall back to the URL flow.
const connectCardRoute = createRoute({
	method: 'post',
	path: '/{id}/connect-card',
	'x-viewer-policy': 'writer',
	tags: ['Sessions'],
	summary: 'Post an integration Connect card into the session chat',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		body: { content: { 'application/json': { schema: sessionConnectCardSchema } } },
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						posted: z.boolean(),
						message_id: z.number().optional(),
						already_connected: z.boolean().optional(),
					}),
				},
			},
			description: 'Card posted, or the provider is already connected and nothing was posted',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Unknown provider',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller does not own this session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session is not an interactive chat session',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Card could not be persisted',
		},
	},
})

app.openapi(connectCardRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { provider: providerName } = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	if (session.actorId !== actorId) {
		return c.json(createApiError('FORBIDDEN', 'Session belongs to a different actor'), 403)
	}

	await isWorkspaceWriter(db, actorId, session.workspaceId)

	if (!session.interactive || !session.conversationId) {
		return c.json(
			createApiError(
				'CONFLICT',
				'Session is not an interactive chat session, so there is no card to show',
			),
			409,
		)
	}

	// Registry membership is the only validation the provider name needs — it is
	// stored on the message and resolved against the live provider list by the UI.
	const provider = listProviders().find((p) => p.config.name === providerName)
	if (!provider) {
		return c.json(
			createApiError('BAD_REQUEST', `Unknown integration provider: ${providerName}`),
			400,
		)
	}

	// Live status, not cached registration: an active row is the only proof the
	// workspace is connected. For a single-install provider that means there is
	// nothing to show — tell the agent so it carries on. A multi-install provider
	// (another GitHub org, another LinkedIn account) still gets the card, which
	// renders "Connected" beside a "+ Add another" button.
	if (!MULTI_INSTALL_PROVIDERS.has(providerName)) {
		const [active] = await db
			.select({ id: integrations.id })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, session.workspaceId),
					eq(integrations.provider, providerName),
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)
		if (active) return c.json({ posted: false, already_connected: true })
	}

	const created = await insertConversationMessage(db, {
		conversationId: session.conversationId,
		workspaceId: session.workspaceId,
		actorId: session.actorId,
		content: formatIntegrationConnectAsMarkdown(provider.config.displayName),
		metadata: { integration_connect: { session_id: session.id, provider: providerName } },
		sessionId: session.id,
	})

	// Null means a unique constraint suppressed the insert, which this caller has
	// no dedupe key to trigger. Surface it as a 500, never a 409 (see /ask).
	if (!created) {
		logger.error('Integration connect card insert returned no row', {
			sessionId: session.id,
			conversationId: session.conversationId,
			provider: providerName,
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Connect card could not be posted'), 500)
	}

	logger.info('Posted integration connect card into conversation', {
		sessionId: session.id,
		conversationId: session.conversationId,
		messageId: created.id,
		provider: providerName,
	})

	return c.json({ posted: true, message_id: created.id })
}) as RouteHandler<typeof connectCardRoute, Env>)

// POST /:id/keychain-card - Ask the human for a credential with a card in the chat
//
// Called by the `request_keychain_credential` MCP tool when it runs inside a chat
// session. The human types the credential into the card, which sends it straight to
// the vault, so a password never passes through the model and the agent never has to
// ask for one in plain text. Same gates as /connect-card: only the agent that owns an
// interactive chat session may post, and anything else gets a 409 so the tool can say
// there is nobody to ask.
const keychainCardRoute = createRoute({
	method: 'post',
	path: '/{id}/keychain-card',
	'x-viewer-policy': 'writer',
	tags: ['Sessions'],
	summary: 'Post a Keychain credential card into the session chat',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		body: { content: { 'application/json': { schema: sessionKeychainCardSchema } } },
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({ posted: z.literal(true), message_id: z.number() }),
				},
			},
			description: 'Card posted',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller does not own this session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session is not an interactive chat session',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Card could not be persisted',
		},
	},
})

app.openapi(keychainCardRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { kind, suggested_name: suggestedName, hint } = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	if (session.actorId !== actorId) {
		return c.json(createApiError('FORBIDDEN', 'Session belongs to a different actor'), 403)
	}

	await isWorkspaceWriter(db, actorId, session.workspaceId)

	if (!session.interactive || !session.conversationId) {
		return c.json(
			createApiError(
				'CONFLICT',
				'Session is not an interactive chat session, so there is nobody to show a card to',
			),
			409,
		)
	}

	const created = await insertConversationMessage(db, {
		conversationId: session.conversationId,
		workspaceId: session.workspaceId,
		actorId: session.actorId,
		content: formatKeychainRequestAsMarkdown(kind, suggestedName, hint),
		metadata: {
			keychain_request: {
				session_id: session.id,
				kind,
				...(suggestedName ? { suggested_name: suggestedName } : {}),
				...(hint ? { hint } : {}),
			},
		},
		sessionId: session.id,
	})

	// Null means a unique constraint suppressed the insert, which this caller has
	// no dedupe key to trigger. Surface it as a 500, never a 409 (see /ask).
	if (!created) {
		logger.error('Keychain card insert returned no row', {
			sessionId: session.id,
			conversationId: session.conversationId,
			kind,
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Keychain card could not be posted'), 500)
	}

	// The kind only: the suggested name and hint are the agent's words, not secrets,
	// but there is no reason for them to be in a log line either.
	logger.info('Posted keychain card into conversation', {
		sessionId: session.id,
		conversationId: session.conversationId,
		messageId: created.id,
		kind,
	})

	return c.json({ posted: true as const, message_id: created.id }, 200)
}) as RouteHandler<typeof keychainCardRoute, Env>)

// POST /:id/computer-card - Ask the human to act on the agent's own computer, in the chat
//
// Called by the `show_computer` MCP tool when it runs inside a chat session. The card
// opens the live view of the asking agent's computer (always its own: the card derives
// whose from the message author, so an agent cannot point it at another agent's) and
// its Done button posts a message, which is what hands control back. Same gates as
// /keychain-card: only the agent that owns an interactive chat session may post, and
// anything else gets a 409 so the tool can say there is nobody to ask.
const computerCardRoute = createRoute({
	method: 'post',
	path: '/{id}/computer-card',
	'x-viewer-policy': 'writer',
	tags: ['Sessions'],
	summary: "Post an 'act on my computer' card into the session chat",
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		body: { content: { 'application/json': { schema: sessionComputerCardSchema } } },
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({ posted: z.literal(true), message_id: z.number() }),
				},
			},
			description: 'Card posted',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller does not own this session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session is not an interactive chat session',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Card could not be persisted',
		},
	},
})

app.openapi(computerCardRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { task } = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)

	if (session.actorId !== actorId) {
		return c.json(createApiError('FORBIDDEN', 'Session belongs to a different actor'), 403)
	}

	await isWorkspaceWriter(db, actorId, session.workspaceId)

	if (!session.interactive || !session.conversationId) {
		return c.json(
			createApiError(
				'CONFLICT',
				'Session is not an interactive chat session, so there is nobody to show a card to',
			),
			409,
		)
	}

	const created = await insertConversationMessage(db, {
		conversationId: session.conversationId,
		workspaceId: session.workspaceId,
		actorId: session.actorId,
		content: formatComputerRequestAsMarkdown(task),
		metadata: { computer_request: { session_id: session.id, task } },
		sessionId: session.id,
	})

	// Null means a unique constraint suppressed the insert, which this caller has
	// no dedupe key to trigger. Surface it as a 500, never a 409 (see /ask).
	if (!created) {
		logger.error('Computer card insert returned no row', {
			sessionId: session.id,
			conversationId: session.conversationId,
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Computer card could not be posted'), 500)
	}

	// Never the task text: it is the agent's words and may name a site or an account.
	logger.info('Posted computer card into conversation', {
		sessionId: session.id,
		conversationId: session.conversationId,
		messageId: created.id,
	})

	return c.json({ posted: true as const, message_id: created.id }, 200)
}) as RouteHandler<typeof computerCardRoute, Env>)

// GET /:id/keychain-credentials - What this session's agent can ask for from the Keychain
//
// Called by the `list_keychain_credentials` MCP tool. Names and kinds only, never a value,
// and only for credentials a person can actually grant: active saved keys and logins.
// Same gate as the card routes: only the agent that owns the session may ask.
const keychainCredentialsRoute = createRoute({
	method: 'get',
	path: '/{id}/keychain-credentials',
	tags: ['Sessions'],
	summary:
		"List the Keychain credentials in this workspace and whether the session's agent has each",
	request: { headers: workspaceIdHeader, params: sessionParamsSchema },
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						credentials: z.array(
							z.object({
								name: z.string(),
								kind: z.enum(['api_key', 'login']),
								has_access: z.boolean(),
								scope: z.enum(['always', 'this_chat']).nullable(),
							}),
						),
					}),
				},
			},
			description: 'Credentials by name',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller does not own this session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(keychainCredentialsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (session.actorId !== actorId) {
		return c.json(createApiError('FORBIDDEN', 'Session belongs to a different actor'), 403)
	}

	// The same view the agent page and get_actor read, so the lists cannot disagree.
	const { credentials } = await describeAgentAccess(db, session.workspaceId, session.actorId, {
		conversationId: session.conversationId,
	})
	return c.json(
		{
			credentials: credentials.map((cr) => ({
				name: cr.name,
				kind: cr.kind,
				has_access: cr.has_access,
				scope: cr.scope,
			})),
		},
		200,
	)
}) as RouteHandler<typeof keychainCredentialsRoute, Env>)

// POST /:id/keychain-access-card - Ask the human to let this agent use an existing credential
//
// Called by the `request_keychain_access` MCP tool. Posts a card with Allow / Not now. The
// card holds no secret: allowing it grants the agent access (a person only) and restarts
// the agent so the credential is in its environment. Same gates as the other cards.
const keychainAccessCardRoute = createRoute({
	method: 'post',
	path: '/{id}/keychain-access-card',
	'x-viewer-policy': 'writer',
	tags: ['Sessions'],
	summary: 'Post a card in the session chat asking the person to share an existing credential',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		body: { content: { 'application/json': { schema: sessionKeychainAccessCardSchema } } },
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						posted: z.boolean(),
						already_granted: z.boolean(),
						message_id: z.number().nullable(),
					}),
				},
			},
			description: 'Card posted, or the agent already has the credential',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller does not own this session',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session or credential not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session is not an interactive chat session',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Card could not be persisted',
		},
	},
})

app.openapi(keychainAccessCardRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { credential_name: credentialName, hint } = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (session.actorId !== actorId) {
		return c.json(createApiError('FORBIDDEN', 'Session belongs to a different actor'), 403)
	}
	await isWorkspaceWriter(db, actorId, session.workspaceId)

	if (!session.interactive || !session.conversationId) {
		return c.json(
			createApiError(
				'CONFLICT',
				'Session is not an interactive chat session, so there is nobody to show a card to',
			),
			409,
		)
	}

	// By name, the way a person and the list tool know it. Active saved keys and logins only.
	const [credential] = await db
		.select({
			id: integrations.id,
			name: integrations.displayName,
			mode: integrations.providerMode,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, session.workspaceId),
				inArray(integrations.providerMode, ['byo_apikey', 'byo_login']),
				eq(integrations.status, 'active'),
				sql`lower(${integrations.displayName}) = lower(${credentialName})`,
			),
		)
		.limit(1)
	if (!credential?.name) {
		return c.json(
			createApiError(
				'NOT_FOUND',
				'No credential with that name. Use list_keychain_credentials for the names, or request_keychain_credential to ask for a new one.',
			),
			404,
		)
	}

	// A grant, or an Allow for this very chat, both mean the agent has it already.
	const current = await resolveAgentAccess(
		db,
		session.workspaceId,
		credential.id,
		session.actorId,
		{
			conversationId: session.conversationId,
		},
	)
	if (current && current !== 'none')
		return c.json({ posted: false, already_granted: true, message_id: null }, 200)

	const created = await insertConversationMessage(db, {
		conversationId: session.conversationId,
		workspaceId: session.workspaceId,
		actorId: session.actorId,
		content: formatKeychainAccessRequestAsMarkdown(credential.name, hint),
		metadata: {
			keychain_access_request: {
				session_id: session.id,
				integration_id: credential.id,
				credential_name: credential.name,
				kind: credential.mode === 'byo_login' ? 'login' : 'api_key',
				...(hint ? { hint } : {}),
			},
		},
		sessionId: session.id,
	})
	if (!created) {
		logger.error('Keychain access card insert returned no row', {
			sessionId: session.id,
			conversationId: session.conversationId,
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Keychain access card could not be posted'), 500)
	}
	logger.info('Posted keychain access card into conversation', {
		sessionId: session.id,
		conversationId: session.conversationId,
		messageId: created.id,
		integrationId: credential.id,
	})
	return c.json({ posted: true, already_granted: false, message_id: created.id }, 200)
}) as RouteHandler<typeof keychainAccessCardRoute, Env>)

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
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session is private to the person who started it',
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
	if (!(await canReadSession(db, session, c.get('actorId'), c.get('workspaceRole')))) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	const conditions = [eq(sessionLogs.sessionId, id)]
	if (query.since) conditions.push(gt(sessionLogs.id, query.since))
	if (query.before) conditions.push(lt(sessionLogs.id, query.before))
	if (query.stream) conditions.push(eq(sessionLogs.stream, query.stream))

	// `desc` takes the newest `limit` rows; reverse them before returning so
	// the response is always in ascending id order regardless of which end
	// the caller asked for. Consumers (the chat activity segmenter, the log
	// transcript) all assume chronological order.
	//
	// `before` always implies taking the newest rows below that bound — the
	// caller is walking backward and wants the page immediately preceding
	// what it already holds, not the oldest rows in the whole session.
	const takeNewest = query.before !== undefined || query.order === 'desc'
	const rows = await db
		.select()
		.from(sessionLogs)
		.where(and(...conditions))
		.limit(query.limit)
		.orderBy(takeNewest ? desc(sessionLogs.id) : asc(sessionLogs.id))

	const results = takeNewest ? rows.reverse() : rows

	return c.json(serializeArray(results) as z.infer<typeof sessionLogResponseSchema>[])
}) as RouteHandler<typeof getSessionLogsRoute, Env>)

// GET /:id/activity - Normalized per-message agent activity trace
const getSessionActivityRoute = createRoute({
	method: 'get',
	path: '/{id}/activity',
	tags: ['Sessions'],
	summary: 'Get the agent activity trace (steps) per conversation message',
	description: `Server-side projection of the raw stream-json session logs into compact per-turn steps. Scans at most ${SESSION_ACTIVITY_SCAN_ROWS} of the newest log rows (below before_log_id); a turn straddling the window is completed from its tagged envelope and flagged partial, and message_id looks a turn up even outside the window. Read-only.`,
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		query: sessionActivityQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: sessionActivityResponseSchema } },
			description: 'Activity turns, oldest to newest',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session was started by a different actor',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(getSessionActivityRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (!(await canReadSession(db, session, c.get('actorId'), c.get('workspaceRole')))) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	const { turns, oldestLogId, hasOlder } = await loadSessionActivity(db, id, {
		limitTurns: query.limit_turns,
		messageId: query.message_id,
		beforeLogId: query.before_log_id,
	})

	return c.json({
		session_id: id,
		turns,
		oldest_log_id: oldestLogId,
		has_older: hasOlder,
	} satisfies z.infer<typeof sessionActivityResponseSchema>)
}) as RouteHandler<typeof getSessionActivityRoute, Env>)

// GET /:id/logs/deep - Cursor-paginated log read that mirrors the get_session_logs
// MCP tool. Distinct from /:id/logs above: this route returns rows in the
// requested direction (newest_first → id DESC) rather than always ascending.
// The existing /:id/logs route KEEPS its ascending semantics for today's UI
// callers (spec §8 rabbit hole 5 — do not break existing consumers).
const getSessionLogsDeepRoute = createRoute({
	method: 'get',
	path: '/{id}/logs/deep',
	tags: ['Sessions'],
	summary: 'Deep-read session logs with cursor pagination (newest-first by default)',
	request: {
		headers: workspaceIdHeader,
		params: sessionParamsSchema,
		query: sessionLogsDeepQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(sessionLogResponseSchema) } },
			description: 'Session logs in the requested direction',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session is private to the person who started it',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Session not found',
		},
	},
})

app.openapi(getSessionLogsDeepRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const session = await loadSessionWithAuth(db, id, workspaceId)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (!(await canReadSession(db, session, c.get('actorId'), c.get('workspaceRole')))) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	const conditions = [eq(sessionLogs.sessionId, id)]
	if (query.before_id !== undefined) conditions.push(lt(sessionLogs.id, query.before_id))
	if (query.after_id !== undefined) conditions.push(gt(sessionLogs.id, query.after_id))
	if (query.stream) conditions.push(eq(sessionLogs.stream, query.stream))

	// Rows returned in the requested direction, NOT reversed. This is the
	// deliberate break from the /:id/logs route at 712-798 above: a caller
	// asking for newest_first wants the failure at index 0.
	//
	// Uses composite index session_logs_session_id_id_idx on (session_id, id)
	// at packages/db/src/schema.ts:439 — the index's own docstring names this
	// exact query as the reason it exists. Verified via EXPLAIN.
	const rows = await db
		.select()
		.from(sessionLogs)
		.where(and(...conditions))
		.limit(query.limit)
		.orderBy(query.direction === 'newest_first' ? desc(sessionLogs.id) : asc(sessionLogs.id))

	return c.json(serializeArray(rows) as z.infer<typeof sessionLogResponseSchema>[])
}) as RouteHandler<typeof getSessionLogsDeepRoute, Env>)

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
	if (!(await canReadSession(db, authSession, c.get('actorId'), c.get('workspaceRole')))) {
		return c.json(createApiError('FORBIDDEN', 'Session was started by a different actor'), 403)
	}

	// Include 'paused' so a client subscribing to an already-paused session
	// receives replay + done instead of hanging in the keep-alive loop below.
	const terminalStatuses = ['completed', 'failed', 'timeout', 'user_stopped', 'paused']

	// Disable proxy response buffering so frames reach the browser as they're
	// written rather than when an intermediary's buffer happens to fill.
	c.header('X-Accel-Buffering', 'no')

	return streamSSE(c, async (stream) => {
		// Check if session is already in terminal state
		const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)

		// Honored by both the terminal replay-all branch and the missed-logs
		// replay branch below, so a client that already hydrated via GET /logs
		// never gets rows it has already rendered re-emitted on top of them.
		const parsedLogId = Number(lastLogId)
		const hasLastLogId = Boolean(lastLogId) && Number.isFinite(parsedLogId) && parsedLogId > 0

		if (session && terminalStatuses.includes(session.status)) {
			// Replay logs for completed sessions, then close
			const allLogs = await db
				.select()
				.from(sessionLogs)
				.where(
					hasLastLogId
						? and(eq(sessionLogs.sessionId, sessionId), gt(sessionLogs.id, parsedLogId))
						: eq(sessionLogs.sessionId, sessionId),
				)
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
		if (hasLastLogId) {
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
		// Resolved when the stream should stop — either the client disconnects
		// (stream.onAbort) or the session reaches a terminal state. Used to make
		// the keep-alive sleep abort-aware so we don't hold the SSE handler open
		// after the client has gone (stream.sleep is a plain setTimeout and does
		// not respond to stream abort on its own).
		let resolveClose = () => {}
		const closeSignal = new Promise<void>((resolve) => {
			resolveClose = resolve
		})

		// Maps a system-log prefix to the `done` payload to emit when a session
		// reaches that terminal state. Using prefix matching because log content
		// may include trailing detail (e.g. "Session completed with exit code 0").
		const TERMINAL_SYSTEM_LOGS: Array<{ prefix: string; done: string }> = [
			{ prefix: 'Session completed', done: 'completed' },
			{ prefix: 'Session failed', done: 'failed' },
			{ prefix: 'Session stopped', done: 'user_stopped' },
			{ prefix: 'Session timed out', done: 'timeout' },
			{ prefix: 'Session paused', done: 'paused' },
		]
		const handler = (event: SessionLogEvent) => {
			if (event.sessionId !== sessionId) return
			// writeSSE returns a Promise. We're in an event listener (sync) so
			// we can't await it. Note: Hono's stream.write() swallows write errors
			// internally, so emit() never rejects in practice — the catch is
			// defensive only.
			const emit = async () => {
				await stream.writeSSE({
					id: String(event.logId),
					event: event.stream,
					data: event.data,
				})
				if (event.stream === 'system') {
					const terminal = TERMINAL_SYSTEM_LOGS.find((t) => event.data.startsWith(t.prefix))
					if (terminal) {
						closed = true
						await stream.writeSSE({ event: 'done', data: terminal.done })
						resolveClose()
					}
				}
			}
			emit().catch((err) => {
				closed = true
				sessionManager.off('log', handler)
				resolveClose()
				logger.warn('SSE log write failed; detaching listener', {
					err: err instanceof Error ? err.message : String(err),
					sessionId,
				})
			})
		}

		sessionManager.on('log', handler)
		// When the client disconnects, exit the keep-alive loop immediately rather
		// than waiting up to 30 s for the next sleep to complete. Without this,
		// the zombie handler holds the HTTP connection open, preventing
		// fetchEventSource from detecting the disconnect and reconnecting.
		stream.onAbort(() => {
			closed = true
			sessionManager.off('log', handler)
			resolveClose()
		})

		// Keep connection alive, but stop if session reached terminal state or
		// the client disconnected. Promise.race makes the sleep abort-aware:
		// resolveClose() fires immediately on abort so we don't wait the full
		// interval before discovering the client is gone.
		//
		// The comment frame is what actually keeps it alive — sleeping alone
		// writes nothing, so a quiet session (an agent thinking for a minute)
		// looks idle to every proxy on the path and gets reaped. See the same
		// fix on the workspace events stream in routes/events.ts.
		while (!closed) {
			await Promise.race([stream.sleep(SSE_HEARTBEAT_MS), closeSignal])
			if (closed) break
			try {
				await stream.write(': ping\n\n')
			} catch {
				break
			}
		}
	})
})

export default app
