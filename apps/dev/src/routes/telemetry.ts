import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { mcpTelemetry } from '@maskin/db/schema'
import {
	mcpTelemetrySummaryQuerySchema,
	mcpTelemetrySummarySchema,
	recordMcpTelemetrySchema,
} from '@maskin/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
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
// Lean-MCP-results bet (`09ea5321-…`) — primary success metric, target ≥30%
// of MCP sessions include at least one deep-link click. Set here so it ships
// alongside the rich-render / mutation targets the dashboard already exposes.
const CLICK_SESSION_TARGET_PCT = 30
const DEFAULT_WINDOW_DAYS = 30

const app = new OpenAPIHono<Env>()

// POST /api/telemetry/mcp — record a single MCP telemetry event.
const recordRoute = createRoute({
	method: 'post',
	path: '/mcp',
	tags: ['Telemetry'],
	summary: 'Record an MCP telemetry event (tool_call or mutation).',
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
			contentBytes: body.content_bytes ?? null,
			contentTokens: body.content_tokens ?? null,
			structuredContentBytes: body.structured_content_bytes ?? null,
		})
	} else {
		await db.insert(mcpTelemetry).values({
			workspaceId,
			eventType: 'mutation',
			toolName: body.tool_name,
			sessionId: body.session_id ?? null,
			objectType: body.object_type ?? null,
			mutationKind: body.mutation_kind,
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
	// and distinct session_id with at least one mutation / deep_link_click
	// (numerators). The HAVING clause enforces "produced at least one tool_call"
	// so a session that recorded only mutations or only clicks (a bug /
	// out-of-order delivery / a click on a stale link) doesn't inflate either
	// numerator without contributing to the denominator.
	const sessionRows = await db
		.select({
			session_id: mcpTelemetry.sessionId,
			has_mutation: sql<boolean>`bool_or(${mcpTelemetry.eventType} = 'mutation')`,
			has_click: sql<boolean>`bool_or(${mcpTelemetry.eventType} = 'deep_link_click')`,
		})
		.from(mcpTelemetry)
		.where(and(eq(mcpTelemetry.workspaceId, workspaceId), gte(mcpTelemetry.createdAt, windowStart)))
		.groupBy(mcpTelemetry.sessionId)
		.having(sql`bool_or(${mcpTelemetry.eventType} = 'tool_call')`)

	let sessionsTotal = 0
	let sessionsWithMutation = 0
	let sessionsWithClick = 0
	for (const row of sessionRows) {
		if (!row.session_id) continue
		sessionsTotal++
		if (row.has_mutation) sessionsWithMutation++
		if (row.has_click) sessionsWithClick++
	}
	const mutationSessionPct = sessionsTotal > 0 ? (sessionsWithMutation / sessionsTotal) * 100 : 0
	const clickSessionPct = sessionsTotal > 0 ? (sessionsWithClick / sessionsTotal) * 100 : 0

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

	// Deep-link clicks total — counts every redirect served by /r/:ws (Task 1).
	const clickCountRows = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(mcpTelemetry)
		.where(
			and(
				eq(mcpTelemetry.workspaceId, workspaceId),
				eq(mcpTelemetry.eventType, 'deep_link_click'),
				gte(mcpTelemetry.createdAt, windowStart),
			),
		)
	const clicksTotal = clickCountRows[0]?.total ?? 0

	// Tokens-per-tool-result (bet's secondary success metric, target ≥60%
	// reduction vs. baseline). The averages are restricted to rows where the
	// MCP wrapper actually measured the response, so older clients that don't
	// emit the size fields don't pull the mean down with NULL→0.
	const sizeRows = await db
		.select({
			samples: sql<number>`count(${mcpTelemetry.contentBytes})::int`,
			avg_content_bytes: sql<string | null>`avg(${mcpTelemetry.contentBytes})`,
			avg_content_tokens: sql<string | null>`avg(${mcpTelemetry.contentTokens})`,
			avg_structured_content_bytes: sql<string | null>`avg(${mcpTelemetry.structuredContentBytes})`,
		})
		.from(mcpTelemetry)
		.where(
			and(
				eq(mcpTelemetry.workspaceId, workspaceId),
				eq(mcpTelemetry.eventType, 'tool_call'),
				gte(mcpTelemetry.createdAt, windowStart),
			),
		)
	const sizeRow = sizeRows[0]
	const toolCallSizeSamples = sizeRow?.samples ?? 0
	// pg's avg() returns a numeric string; coerce to number for the JSON
	// response. Null when there are zero samples.
	const numericOrNull = (v: string | null): number | null => {
		if (v == null) return null
		const n = Number(v)
		return Number.isFinite(n) ? n : null
	}
	const avgContentBytes = numericOrNull(sizeRow?.avg_content_bytes ?? null)
	const avgContentTokens = numericOrNull(sizeRow?.avg_content_tokens ?? null)
	const avgStructuredContentBytes = numericOrNull(sizeRow?.avg_structured_content_bytes ?? null)

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
		clicks_total: clicksTotal,
		sessions_with_click: sessionsWithClick,
		click_session_pct: clickSessionPct,
		click_session_target_pct: CLICK_SESSION_TARGET_PCT,
		click_session_target_met: clickSessionPct >= CLICK_SESSION_TARGET_PCT,
		avg_content_bytes: avgContentBytes,
		avg_content_tokens: avgContentTokens,
		avg_structured_content_bytes: avgStructuredContentBytes,
		tool_call_size_samples: toolCallSizeSamples,
	})
}) as RouteHandler<typeof summaryRoute, Env>)

export default app
