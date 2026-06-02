import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { mcpTelemetry } from '@maskin/db/schema'
import {
	mcpTelemetrySummaryQuerySchema,
	mcpTelemetrySummarySchema,
	recordMcpTelemetrySchema,
} from '@maskin/shared'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
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
const DEFAULT_WINDOW_DAYS = 30

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

const app = new OpenAPIHono<Env>()

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
	// Each of the four queries below touches a bounded slice of mcp_telemetry —
	// the previous single fetch had no SQL bound and would scale linearly with
	// bet-widget history once volume picks up. Renders sent by agents are
	// excluded via `data->>'actor_type' != 'agent'`. Rows persisted before that
	// column existed have no actor_type and are treated as human (the
	// visibility gate from T7 is the primary defense; this filter is defense-
	// in-depth). The bet-first window is absolute (it measures the first N bet
	// renders ever, not a sliding window), so the `since` query param does NOT
	// clip these queries.
	const widgetBaseWhere = and(
		eq(mcpTelemetry.workspaceId, workspaceId),
		eq(mcpTelemetry.eventType, 'widget_event'),
		eq(mcpTelemetry.objectType, 'bet'),
		sql`coalesce(${mcpTelemetry.data}->>'actor_type', 'human') <> 'agent'`,
	)

	// 1. Three filtered counters for the running totals. Returns one row of
	//    ints regardless of underlying scan size.
	const widgetTotalsRows = await db
		.select({
			renders: sql<number>`count(*) filter (where ${mcpTelemetry.data}->>'event' = 'render_success')::int`,
			errors: sql<number>`count(*) filter (where ${mcpTelemetry.data}->>'event' = 'render_error')::int`,
			clicks: sql<number>`count(*) filter (where ${mcpTelemetry.data}->>'event' = 'click_through')::int`,
		})
		.from(mcpTelemetry)
		.where(widgetBaseWhere)
	const widgetTotals = widgetTotalsRows[0] ?? { renders: 0, errors: 0, clicks: 0 }

	// 2. First 200 render_success rows in chronological order. `LIMIT 200`
	//    is the hard upper bound — the bet-first window never reads more.
	const firstRenderRows = await db
		.select({
			session_id: mcpTelemetry.sessionId,
			tool_name: mcpTelemetry.toolName,
			object_id: sql<string | null>`(${mcpTelemetry.data}->>'object_id')`,
			created_at: mcpTelemetry.createdAt,
		})
		.from(mcpTelemetry)
		.where(and(widgetBaseWhere, sql`${mcpTelemetry.data}->>'event' = 'render_success'`))
		.orderBy(mcpTelemetry.createdAt)
		.limit(WIDGET_BET_FIRST_WINDOW_SIZE)

	// 3. Click_throughs that correlate to one of the first-200 render keys
	//    AND occurred at or after the first render — replayed or out-of-order
	//    clicks can't credit a render that hasn't happened yet. Both bounds
	//    are pushed into SQL; the JS-side filter in step 5 only narrows
	//    further from first-200 to first-50.
	let correlatedClickRows: ReadonlyArray<{
		session_id: string | null
		tool_name: string
		object_id: string | null
		created_at: Date
	}> = []
	const firstRenderHead = firstRenderRows[0]
	if (firstRenderHead) {
		const firstRenderTs = firstRenderHead.created_at
		const correlatorKey = (k: {
			session_id: string | null
			tool_name: string
			object_id: string | null
		}) => `${k.session_id ?? ''}::${k.tool_name}::${k.object_id ?? ''}`
		const firstRenderKeys = firstRenderRows.map(correlatorKey)
		const correlatorExpr = sql<string>`concat(coalesce(${mcpTelemetry.sessionId}, ''), '::', ${mcpTelemetry.toolName}, '::', coalesce(${mcpTelemetry.data}->>'object_id', ''))`
		correlatedClickRows = await db
			.select({
				session_id: mcpTelemetry.sessionId,
				tool_name: mcpTelemetry.toolName,
				object_id: sql<string | null>`(${mcpTelemetry.data}->>'object_id')`,
				created_at: mcpTelemetry.createdAt,
			})
			.from(mcpTelemetry)
			.where(
				and(
					widgetBaseWhere,
					sql`${mcpTelemetry.data}->>'event' = 'click_through'`,
					gte(mcpTelemetry.createdAt, firstRenderTs),
					inArray(correlatorExpr, firstRenderKeys),
				),
			)
	}

	// 4. Render attempts (success + error) in the trailing 48h window.
	//    Clipped by `created_at` so the scan is bounded by the time index.
	const errorWindowStart = new Date(now.getTime() - WIDGET_RENDER_ERROR_WINDOW_MS)
	const errorWindowRows = await db
		.select({
			event: sql<string>`(${mcpTelemetry.data}->>'event')::text`,
		})
		.from(mcpTelemetry)
		.where(
			and(
				widgetBaseWhere,
				sql`${mcpTelemetry.data}->>'event' in ('render_success', 'render_error')`,
				gte(mcpTelemetry.createdAt, errorWindowStart),
			),
		)

	// 5. Combine into the bet-first window shape (pure function, testable).
	const widgetBetFirstWindow = buildWidgetBetFirstWindow({
		totals: widgetTotals,
		firstRenders: firstRenderRows,
		correlatedClicks: correlatedClickRows,
		errorWindowRows,
	})

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

interface RenderKey {
	session_id: string | null
	tool_name: string
	object_id: string | null
}

interface RenderRow extends RenderKey {
	created_at: Date
}

interface ErrorWindowRow {
	event: string
}

interface WidgetTotals {
	renders: number
	errors: number
	clicks: number
}

// Computes the bet's success and kill metrics from the four structured query
// results. Pure function, exported for testing. The matching rule for
// click_through → render is shared `(session_id, tool_name, object_id)` —
// `recordWidgetEvent` always emits the same triple for the render and the
// click on the same card. Null object_id matches null across the pair (so list
// cards with no specific object still correlate).
function buildWidgetBetFirstWindow({
	totals,
	firstRenders,
	correlatedClicks,
	errorWindowRows,
}: {
	totals: WidgetTotals
	firstRenders: readonly RenderRow[]
	correlatedClicks: readonly RenderRow[]
	errorWindowRows: readonly ErrorWindowRow[]
}) {
	const correlatorKey = (r: RenderKey) =>
		`${r.session_id ?? ''}::${r.tool_name}::${r.object_id ?? ''}`

	const first200 = firstRenders.slice(0, WIDGET_BET_FIRST_WINDOW_SIZE)
	const first50 = firstRenders.slice(0, WIDGET_BET_KILL_WINDOW_SIZE)

	// The SQL already filtered correlatedClicks to the first-200 key set; the
	// first-50 subset is enforced here in JS.
	const first50KeySet = new Set(first50.map(correlatorKey))
	const clicks200 = correlatedClicks.length
	const clicks50 = correlatedClicks.filter((c) => first50KeySet.has(correlatorKey(c))).length

	const pctOrNull = (num: number, denom: number) => (denom > 0 ? (num / denom) * 100 : null)

	const ctr200Pct = pctOrNull(clicks200, first200.length)
	const ctr50Pct = pctOrNull(clicks50, first50.length)

	const renders48h = errorWindowRows.filter((r) => r.event === 'render_success').length
	const errors48h = errorWindowRows.filter((r) => r.event === 'render_error').length
	const attempts48h = renders48h + errors48h
	const errorPct48h = pctOrNull(errors48h, attempts48h)

	return {
		bet_renders_total: totals.renders,
		bet_render_errors_total: totals.errors,
		bet_click_throughs_total: totals.clicks,
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
