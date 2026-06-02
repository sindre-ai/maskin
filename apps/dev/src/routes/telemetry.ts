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
const DEFAULT_WINDOW_DAYS = 30
// Rolling kill criterion from the MCP Widget UX bet — pause shipping and
// revert to Markdown deep-link fallback if widget render failures exceed this
// in any 48h window. Surfaced as `render_error_kill_switch_breach` in the
// summary response; dashboards/cron should escalate to Magnus via Slack on
// breach (see ce02150d-7666-45ec-ba6d-4fdea86f23c2 Exit criteria).
const RENDER_ERROR_KILL_SWITCH_PCT = 10
const RENDER_ERROR_WINDOW_MS = 48 * 60 * 60 * 1000

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
		// CTR aggregation reads them back via jsonb operators.
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

	// Rolling 48h widget render-error rate. Counts only mount-time signals —
	// `render_success` (denominator increment) and `render_error` (both). The
	// `event` sub-field lives on `data` (jsonb) because the widget event shape
	// is more granular than the columned tool_call/mutation rows and the schema
	// extension for it is owned by T8. Until T8 lands the schema entry, this
	// returns 0/0 and the breach boolean is false — additive and safe.
	const renderWindowStart = new Date(now.getTime() - RENDER_ERROR_WINDOW_MS)
	const renderRows = await db
		.select({
			renders: sql<number>`count(*) filter (where ${mcpTelemetry.data}->>'event' in ('render_success', 'render_error'))::int`,
			errors: sql<number>`count(*) filter (where ${mcpTelemetry.data}->>'event' = 'render_error')::int`,
		})
		.from(mcpTelemetry)
		.where(
			and(
				eq(mcpTelemetry.workspaceId, workspaceId),
				eq(mcpTelemetry.eventType, 'widget_event'),
				gte(mcpTelemetry.createdAt, renderWindowStart),
			),
		)
	const widgetRenders48h = renderRows[0]?.renders ?? 0
	const widgetRenderErrors48h = renderRows[0]?.errors ?? 0
	const renderErrorPct48h =
		widgetRenders48h > 0 ? (widgetRenderErrors48h / widgetRenders48h) * 100 : 0
	const renderErrorKillSwitchBreach =
		widgetRenders48h > 0 && renderErrorPct48h > RENDER_ERROR_KILL_SWITCH_PCT

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
		widget_renders_48h: widgetRenders48h,
		widget_render_errors_48h: widgetRenderErrors48h,
		render_error_pct_48h: renderErrorPct48h,
		render_error_kill_switch_pct: RENDER_ERROR_KILL_SWITCH_PCT,
		render_error_kill_switch_breach: renderErrorKillSwitchBreach,
	})
}) as RouteHandler<typeof summaryRoute, Env>)

export default app
