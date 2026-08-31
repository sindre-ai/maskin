import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { mcpTelemetry } from '@maskin/db/schema'
import {
	mcpTelemetrySummaryQuerySchema,
	mcpTelemetrySummarySchema,
	recordMcpTelemetrySchema,
} from '@maskin/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import { recordMcpMisfire } from '../lib/analytics/mcp-misfire'
import { captureMcpToolCall } from '../lib/analytics/mcp-tool-calls'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const RICH_RENDER_TARGET_PCT = 50
const MUTATION_SESSION_TARGET_PCT = 20
const DEFAULT_WINDOW_DAYS = 30

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// POST /api/telemetry/mcp — record a single MCP telemetry event.
const recordRoute = createRoute({
	method: 'post',
	path: '/mcp',
	tags: ['Telemetry'],
	summary:
		'Record an MCP telemetry event (tool_call, mutation, error, or tool_call_response_size).',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: recordMcpTelemetrySchema } } },
	},
	responses: {
		202: {
			description: 'Event accepted',
			content: { 'application/json': { schema: z.object({ recorded: z.literal(true) }) } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(recordRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a workspace member'), 403)
	}

	if (body.event_type === 'tool_call') {
		await db.insert(mcpTelemetry).values({
			workspaceId,
			eventType: 'tool_call',
			toolName: body.tool_name,
			sessionId: body.session_id ?? null,
			hasRichRender: body.has_rich_render,
			durationMs: body.duration_ms,
		})
		// Trace fan-out for stdio clients (Claude Code, Cursor, …), whose calls
		// only ever reach us through this sink.
		//
		// HTTP-transport events are deliberately skipped: on that path the MCP
		// server runs in-process behind `POST /mcp` and its sink loops straight
		// back here, while `routes/mcp.ts` already emits the trace server-side
		// with a real session id. Emitting here too would double-count every
		// HTTP tool call. `transport` is optional, so an older MCP server build
		// (which sends neither field) still gets traced — stdio is the
		// overwhelmingly likely origin for such a client.
		if (body.transport !== 'http') {
			// An id-less client gets a per-request id, never a shared literal.
			// Collapsing them onto one constant would interleave unrelated
			// processes into a single apparent session with mixed seq counters —
			// worse than no grouping. `routes/mcp.ts` mints an `anon-` id for the
			// same reason; matched here.
			const sessionId =
				body.session_id ??
				`anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
			void captureMcpToolCall(workspaceId, {
				sessionId,
				// Trust the client's own account of how it resolved the id: only it
				// can tell a real `sessions.id` from its per-process correlation id.
				// An older build sends nothing, so fall back to the conservative
				// `process` — never `maskin-session`, which would claim a join back
				// to the sessions row that may not exist.
				sessionSource: body.session_id ? (body.session_source ?? 'process') : 'unknown',
				// Null, not 0: `seq` is 1-based, so 0 is out of band and would sort
				// ahead of every real call in an ordering query.
				seq: body.seq ?? null,
				toolName: body.tool_name,
				argKeys: body.arg_keys ?? [],
				ok: body.ok ?? true,
				// The stdio sink reports failure without a reason, so bucket it the
				// same way the HTTP path buckets an error it cannot classify. Using
				// null here instead would make stdio failures indistinguishable from
				// successes when grouping by `error_class`.
				errorClass: body.ok === false ? 'unclassified' : null,
				durationMs: body.duration_ms,
				responseBytes: null,
				transport: 'stdio',
				agentActorId: actorId,
			})
		}
	} else if (body.event_type === 'mutation') {
		await db.insert(mcpTelemetry).values({
			workspaceId,
			eventType: 'mutation',
			toolName: body.tool_name,
			sessionId: body.session_id ?? null,
			objectType: body.object_type ?? null,
			mutationKind: body.mutation_kind,
		})
	} else if (body.event_type === 'error') {
		// MCP misfire ingest for the agent-reach-signal bet. Persisted to
		// `mcp_telemetry.data` (jsonb, no schema migration) and fanned out to
		// PostHog inside `recordMcpMisfire`. Best-effort: a PostHog outage or
		// DB hiccup here must not surface a 5xx to the sink.
		void recordMcpMisfire(db, workspaceId, {
			kind: body.kind,
			toolName: body.tool_name,
			requestedShape: body.requested_shape,
			sessionId: body.session_id ?? null,
			agentActorId: body.agent_actor_id ?? null,
		})
	} else {
		// tool_call_response_size — PostHog-only fan-out for the MCP
		// response-scoping bet's First test — 5-day instrumentation window
		// doesn't earn a schema migration. The Product Analyst's baseline query
		// reads `mcp_tool_call_response_size` rows directly from PostHog.
		// Fire-and-forget; `capturePosthogEvent` never throws.
		void capturePosthogEvent('mcp_tool_call_response_size', workspaceId, {
			tool_name: body.tool_name,
			session_id: body.session_id ?? null,
			content_bytes: body.content_bytes,
			content_tokens: body.content_tokens,
			structured_content_bytes: body.structured_content_bytes,
			structured_content_tokens: body.structured_content_tokens,
			truncated: body.truncated,
			workspace_id: workspaceId,
		})
	}

	return c.json({ recorded: true as const }, 202)
}) as RouteHandler<typeof recordRoute, Env>)

// GET /api/telemetry/mcp/summary — aggregated bet success metrics for a window.
const summaryRoute = createRoute({
	method: 'get',
	path: '/mcp/summary',
	tags: ['Telemetry'],
	summary: 'Aggregate MCP telemetry into bet success-metric numbers.',
	request: {
		headers: workspaceIdHeader,
		query: mcpTelemetrySummaryQuerySchema,
	},
	responses: {
		200: {
			description: 'Aggregate summary for the requested window',
			content: { 'application/json': { schema: mcpTelemetrySummarySchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(summaryRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { since, days } = c.req.valid('query')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a workspace member'), 403)
	}

	const now = new Date()
	const windowStart = since
		? new Date(since)
		: new Date(now.getTime() - (days ?? DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000)

	// Tool-call totals (denominator + rich-render numerator).
	const toolCallRows = await db
		.select({
			total: sql<number>`count(*)::int`,
			rich: sql<number>`count(*) filter (where ${mcpTelemetry.hasRichRender} = true)::int`,
		})
		.from(mcpTelemetry)
		.where(
			and(
				eq(mcpTelemetry.workspaceId, workspaceId),
				eq(mcpTelemetry.eventType, 'tool_call'),
				gte(mcpTelemetry.createdAt, windowStart),
			),
		)

	const toolCallsTotal = toolCallRows[0]?.total ?? 0
	const toolCallsRich = toolCallRows[0]?.rich ?? 0
	const richPct = toolCallsTotal > 0 ? (toolCallsRich / toolCallsTotal) * 100 : 0

	// Sessions: distinct session_id with at least one tool_call (denominator)
	// and distinct session_id with at least one mutation (numerator). The
	// HAVING clause enforces "produced at least one tool_call" so a session
	// that recorded only mutations (a bug / out-of-order delivery) doesn't
	// inflate the numerator without contributing to the denominator.
	const sessionRows = await db
		.select({
			session_id: mcpTelemetry.sessionId,
			has_mutation: sql<boolean>`bool_or(${mcpTelemetry.eventType} = 'mutation')`,
		})
		.from(mcpTelemetry)
		.where(and(eq(mcpTelemetry.workspaceId, workspaceId), gte(mcpTelemetry.createdAt, windowStart)))
		.groupBy(mcpTelemetry.sessionId)
		.having(sql`bool_or(${mcpTelemetry.eventType} = 'tool_call')`)

	let sessionsTotal = 0
	let sessionsWithMutation = 0
	for (const row of sessionRows) {
		if (!row.session_id) continue
		sessionsTotal++
		if (row.has_mutation) sessionsWithMutation++
	}
	const mutationSessionPct = sessionsTotal > 0 ? (sessionsWithMutation / sessionsTotal) * 100 : 0

	// Mutation total — independent counter, useful for raw activity.
	const mutationCountRows = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(mcpTelemetry)
		.where(
			and(
				eq(mcpTelemetry.workspaceId, workspaceId),
				eq(mcpTelemetry.eventType, 'mutation'),
				gte(mcpTelemetry.createdAt, windowStart),
			),
		)
	const mutationsTotal = mutationCountRows[0]?.total ?? 0

	// Per-day rich-render breakdown (UTC day buckets).
	const perDayRows = await db
		.select({
			day: sql<string>`to_char(${mcpTelemetry.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
			total: sql<number>`count(*)::int`,
			rich: sql<number>`count(*) filter (where ${mcpTelemetry.hasRichRender} = true)::int`,
		})
		.from(mcpTelemetry)
		.where(
			and(
				eq(mcpTelemetry.workspaceId, workspaceId),
				eq(mcpTelemetry.eventType, 'tool_call'),
				gte(mcpTelemetry.createdAt, windowStart),
			),
		)
		.groupBy(sql`to_char(${mcpTelemetry.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`)
		.orderBy(sql`to_char(${mcpTelemetry.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`)

	const richRenderByDay = perDayRows.map((r) => ({
		day: r.day,
		tool_calls: r.total,
		rich_calls: r.rich,
		rich_pct: r.total > 0 ? (r.rich / r.total) * 100 : 0,
	}))

	return c.json({
		workspace_id: workspaceId,
		window_start: windowStart.toISOString(),
		window_end: now.toISOString(),
		tool_calls_total: toolCallsTotal,
		tool_calls_rich: toolCallsRich,
		rich_render_pct: richPct,
		rich_render_target_pct: RICH_RENDER_TARGET_PCT,
		rich_render_target_met: richPct >= RICH_RENDER_TARGET_PCT,
		sessions_total: sessionsTotal,
		sessions_with_mutation: sessionsWithMutation,
		mutation_session_pct: mutationSessionPct,
		mutation_session_target_pct: MUTATION_SESSION_TARGET_PCT,
		mutation_session_target_met: mutationSessionPct >= MUTATION_SESSION_TARGET_PCT,
		mutations_total: mutationsTotal,
		rich_render_by_day: richRenderByDay,
	})
}) as RouteHandler<typeof summaryRoute, Env>)

export default app
