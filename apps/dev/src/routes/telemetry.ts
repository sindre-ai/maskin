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
// Rolling kill criterion from the MCP Widget UX bet — pause shipping and
// revert to Markdown deep-link fallback if widget render failures exceed this
// in any 48h window. Surfaced as `render_error_kill_switch_breach` in the
// summary response; dashboards/cron should escalate to Magnus via Slack on
// breach (see ce02150d-7666-45ec-ba6d-4fdea86f23c2 Exit criteria).
// Bet-first measurement window for the MCP widget UX bet. Constants come
// directly from the bet's success/exit criteria:
//   - CTR ≥30% over the first 200 bet renders is the success metric.
//   - <30% CTR on the first 50 renders triggers a reshape (kill window).
//   - >10% render-error rate in any 48h window pauses shipping (kill switch).
const WIDGET_BET_FIRST_WINDOW_SIZE = 200
const WIDGET_BET_KILL_WINDOW_SIZE = 50
const WIDGET_CTR_TARGET_PCT = 30
const WIDGET_CTR_KILL_THRESHOLD_PCT = 30
const WIDGET_RENDER_ERROR_KILL_THRESHOLD_PCT = 10
const WIDGET_RENDER_ERROR_WINDOW_MS = 48 * 60 * 60 * 1000

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// POST /api/telemetry/mcp — record a single MCP telemetry event.
const recordRoute = createRoute({
	method: 'post',
	path: '/mcp',
	tags: ['Telemetry'],
	summary: 'Record an MCP telemetry event (tool_call, mutation, or widget_event).',
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
	} else if (body.event_type === 'tool_call_response_size') {
		// PostHog-only fan-out for the MCP response-scoping bet's First test —
		// 5-day instrumentation window doesn't earn a schema migration. The
		// Product Analyst's baseline query reads `mcp_tool_call_response_size`
		// rows directly from PostHog. Fire-and-forget; `capturePosthogEvent`
		// never throws.
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
	} else {
		// widget_event — widget-only fields (event, widget_name, card_kind, object_id,
		// ts) live in the `data` jsonb column so we avoid a hot-table migration. T9's
		// CTR aggregation reads them back via jsonb operators. `actor_type` is
		// persisted here so the aggregation can exclude agent-recorded renders
		// without a backfill — defense-in-depth alongside T7's visibility gate.
		const actorType = c.get('actorType')
		await db.insert(mcpTelemetry).values({
			workspaceId,
			eventType: 'widget_event',
			toolName: body.tool_name,
			sessionId: body.session_id,
			objectType: body.object_type ?? null,
			data: {
				event: body.event,
				widget_name: body.widget_name,
				card_kind: body.card_kind,
				object_id: body.object_id ?? null,
				ts: body.ts,
				actor_type: actorType,
			},
		})
		// One log line per widget event so the 48h render-error kill criterion is
		// observable in raw logs without running the T9 aggregation query.
		console.log(
			`[telemetry] widget_event ${body.event} — widget=${body.widget_name} tool=${body.tool_name} object_type=${body.object_type ?? 'null'} object_id=${body.object_id ?? 'null'} workspace=${workspaceId}`,
		)
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

	// ── Widget bet-first window ──────────────────────────────────────────
	//
	// Pulls render_success / render_error / click_through widget_event rows for
	// object_type='bet' in chronological order. Renders sent by agents are
	// excluded via `data->>'actor_type' != 'agent'`. Rows persisted before this
	// column existed have no actor_type and are treated as human (the visibility
	// gate from T7 is the primary defense; this filter is defense-in-depth).
	//
	// We pull a bounded slice (200 renders + the click_throughs that correlate
	// to them, plus the 48h error window) rather than streaming the whole table,
	// because the bet-first measurement window is by construction tiny. The
	// `since` query param does NOT clip this set — the bet-first window is
	// absolute (it measures the first N bet renders ever, not a sliding window).
	const widgetRows = await db
		.select({
			event: sql<string>`(${mcpTelemetry.data}->>'event')::text`,
			session_id: mcpTelemetry.sessionId,
			tool_name: mcpTelemetry.toolName,
			object_id: sql<string | null>`(${mcpTelemetry.data}->>'object_id')`,
			created_at: mcpTelemetry.createdAt,
		})
		.from(mcpTelemetry)
		.where(
			and(
				eq(mcpTelemetry.workspaceId, workspaceId),
				eq(mcpTelemetry.eventType, 'widget_event'),
				eq(mcpTelemetry.objectType, 'bet'),
				sql`coalesce(${mcpTelemetry.data}->>'actor_type', 'human') <> 'agent'`,
			),
		)
		.orderBy(mcpTelemetry.createdAt)

	const widgetBetFirstWindow = buildWidgetBetFirstWindow(widgetRows, now)

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
		widget_bet_first_window: widgetBetFirstWindow,
	})
}) as RouteHandler<typeof summaryRoute, Env>)

interface WidgetRow {
	event: string
	session_id: string | null
	tool_name: string
	object_id: string | null
	created_at: Date
}

// Computes the bet's success and kill metrics from chronologically-ordered
// widget_event rows. Pure function, exported for testing. The matching rule for
// click_through → render is shared `(session_id, tool_name, object_id)` —
// `recordWidgetEvent` always emits the same triple for the render and the
// click on the same card. Null/undefined object_id matches null/undefined
// across the pair (so list cards with no specific object still correlate).
function buildWidgetBetFirstWindow(rows: readonly WidgetRow[], now: Date) {
	const renders = rows.filter((r) => r.event === 'render_success')
	const errors = rows.filter((r) => r.event === 'render_error')
	const clicks = rows.filter((r) => r.event === 'click_through')

	const correlatorKey = (r: Pick<WidgetRow, 'session_id' | 'tool_name' | 'object_id'>) =>
		`${r.session_id ?? ''}::${r.tool_name}::${r.object_id ?? ''}`

	const countClicksAgainst = (renderSlice: readonly WidgetRow[]) => {
		if (renderSlice.length === 0) return 0
		const unclickedRenderKeys = new Set(renderSlice.map(correlatorKey))
		// A click only counts if it lands AT OR AFTER the first render in the
		// slice — earlier clicks can't have been triggered by a render that
		// hasn't happened yet (defends against replayed or out-of-order events).
		const firstRenderTs = renderSlice[0]?.created_at.getTime() ?? 0
		let counted = 0
		for (const c of clicks) {
			if (c.created_at.getTime() < firstRenderTs) continue
			const key = correlatorKey(c)
			if (!unclickedRenderKeys.has(key)) continue
			unclickedRenderKeys.delete(key)
			counted++
		}
		return counted
	}

	const first200 = renders.slice(0, WIDGET_BET_FIRST_WINDOW_SIZE)
	const first50 = renders.slice(0, WIDGET_BET_KILL_WINDOW_SIZE)

	const clicks200 = countClicksAgainst(first200)
	const clicks50 = countClicksAgainst(first50)

	const pctOrNull = (num: number, denom: number) => (denom > 0 ? (num / denom) * 100 : null)

	const ctr200Pct = pctOrNull(clicks200, first200.length)
	const ctr50Pct = pctOrNull(clicks50, first50.length)

	// 48h render-error rate — denominator is render attempts (success + error)
	// in the trailing 48h window. Click_throughs are not attempts.
	const errorWindowStart = now.getTime() - WIDGET_RENDER_ERROR_WINDOW_MS
	const renders48h = renders.filter((r) => r.created_at.getTime() >= errorWindowStart).length
	const errors48h = errors.filter((r) => r.created_at.getTime() >= errorWindowStart).length
	const attempts48h = renders48h + errors48h
	const errorPct48h = pctOrNull(errors48h, attempts48h)

	return {
		bet_renders_total: renders.length,
		bet_render_errors_total: errors.length,
		bet_click_throughs_total: clicks.length,
		ctr_first_200: {
			renders: first200.length,
			clicks: clicks200,
			pct: ctr200Pct,
			target_pct: WIDGET_CTR_TARGET_PCT,
			target_met: first200.length > 0 && (ctr200Pct ?? 0) >= WIDGET_CTR_TARGET_PCT,
		},
		ctr_first_50_kill: {
			renders: first50.length,
			clicks: clicks50,
			pct: ctr50Pct,
			kill_threshold_pct: WIDGET_CTR_KILL_THRESHOLD_PCT,
			kill_triggered:
				first50.length >= WIDGET_BET_KILL_WINDOW_SIZE &&
				(ctr50Pct ?? 0) < WIDGET_CTR_KILL_THRESHOLD_PCT,
		},
		render_error_48h: {
			renders: renders48h,
			errors: errors48h,
			pct: errorPct48h,
			kill_threshold_pct: WIDGET_RENDER_ERROR_KILL_THRESHOLD_PCT,
			kill_triggered:
				attempts48h > 0 && (errorPct48h ?? 0) > WIDGET_RENDER_ERROR_KILL_THRESHOLD_PCT,
		},
	}
}

export default app
