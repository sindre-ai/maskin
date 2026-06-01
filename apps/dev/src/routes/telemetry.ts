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
		// widget_event — fan widget-specific fields into the `data` jsonb so a
		// new column isn't needed on a hot table. T9's aggregation reads
		// data->>'event' for CTR and render-error rates.
		await db.insert(mcpTelemetry).values({
			workspaceId,
			eventType: 'widget_event',
			toolName: body.tool_name,
			sessionId: body.session_id ?? null,
			objectType: body.object_type ?? null,
			data: {
				widget_name: body.widget_name,
				event: body.event,
				card_kind: body.card_kind,
				object_id: body.object_id ?? null,
				ts: body.ts ?? null,
			},
		})
		// Surface render failures as warn-level logs so an outage shows up in
		// app logs even before T9's rolling aggregation runs. Success and
		// click-through events are persisted silently — the table is the signal.
		if (body.event === 'render_error') {
			console.warn(
				`[telemetry] widget render_error widget=${body.widget_name} tool=${body.tool_name} object_type=${body.object_type ?? '-'} workspace=${workspaceId}`,
			)
		}
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
