import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: telemetryRoutes } = await import('../../routes/telemetry')

const wsId = '00000000-0000-0000-0000-000000000001'
const memberRow = { actorId: 'test-actor-id' }

describe('Telemetry Routes', () => {
	describe('POST /api/telemetry/mcp', () => {
		it('records a tool_call event for a workspace member', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'tool_call',
						tool_name: 'create_objects',
						has_rich_render: true,
						duration_ms: 42,
						session_id: 'mcp-test-1',
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
			expect(await res.json()).toEqual({ recorded: true })
		})

		it('records a mutation event for a workspace member', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'mutation',
						tool_name: 'update_objects',
						object_type: 'object',
						mutation_kind: 'update',
						session_id: 'mcp-test-2',
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
		})

		it('returns 403 when the actor is not a workspace member', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// First select (membership check) returns no rows.
			mockResults.select = []

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'tool_call',
						tool_name: 'create_objects',
						has_rich_render: false,
						duration_ms: 10,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(403)
		})

		it('returns 400 for an invalid event payload (bad event_type)', async () => {
			const { app } = createTestApp(telemetryRoutes, '/api/telemetry')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{ event_type: 'unknown', tool_name: 'x' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when tool_name has invalid characters', async () => {
			const { app } = createTestApp(telemetryRoutes, '/api/telemetry')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'tool_call',
						tool_name: 'bad name with spaces',
						has_rich_render: true,
						duration_ms: 5,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('records a widget_event render_success for a workspace member', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'widget_event',
						widget_name: 'hero-card',
						event: 'render_success',
						tool_name: 'get_objects',
						session_id: 'mcp-widget-1',
						card_kind: 'single',
						object_type: 'bet',
						object_id: 'bet-123',
						ts: 1717245000000,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
			expect(await res.json()).toEqual({ recorded: true })
		})

		it('records a widget_event click_through for a workspace member', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'widget_event',
						widget_name: 'hero-card',
						event: 'click_through',
						tool_name: 'get_objects',
						session_id: 'mcp-widget-1',
						card_kind: 'single',
						object_type: 'bet',
						object_id: 'bet-123',
						ts: 1717245001000,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
		})

		it('returns 400 when widget_event has unknown event kind', async () => {
			const { app } = createTestApp(telemetryRoutes, '/api/telemetry')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'widget_event',
						widget_name: 'hero-card',
						event: 'hover',
						tool_name: 'get_objects',
						session_id: 'mcp-widget-1',
						card_kind: 'single',
						ts: 1717245000000,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when widget_event is missing session_id', async () => {
			const { app } = createTestApp(telemetryRoutes, '/api/telemetry')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'widget_event',
						widget_name: 'hero-card',
						event: 'render_success',
						tool_name: 'get_objects',
						card_kind: 'single',
						ts: 1717245000000,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 403 when widget_event sender is not a workspace member', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = []

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'widget_event',
						widget_name: 'hero-card',
						event: 'render_error',
						tool_name: 'get_objects',
						session_id: 'mcp-widget-1',
						card_kind: 'single',
						ts: 1717245000000,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('GET /api/telemetry/mcp/summary', () => {
		it('returns zero counters and zero ratios when no telemetry exists', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// 1) workspace membership check, 2) tool_call totals, 3) sessions group, 4) mutations total, 5) per-day rows, 6) widget rows
			mockResults.selectQueue = [[memberRow], [{ total: 0, rich: 0 }], [], [{ total: 0 }], [], []]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=30', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.tool_calls_total).toBe(0)
			expect(body.tool_calls_rich).toBe(0)
			expect(body.rich_render_pct).toBe(0)
			expect(body.rich_render_target_pct).toBe(50)
			expect(body.rich_render_target_met).toBe(false)
			expect(body.sessions_total).toBe(0)
			expect(body.sessions_with_mutation).toBe(0)
			expect(body.mutation_session_pct).toBe(0)
			expect(body.mutation_session_target_pct).toBe(20)
			expect(body.mutation_session_target_met).toBe(false)
			expect(body.mutations_total).toBe(0)
			expect(body.rich_render_by_day).toEqual([])
			expect(body.widget_bet_first_window).toEqual({
				bet_renders_total: 0,
				bet_render_errors_total: 0,
				bet_click_throughs_total: 0,
				ctr_first_200: { renders: 0, clicks: 0, pct: null, target_pct: 30, target_met: false },
				ctr_first_50_kill: {
					renders: 0,
					clicks: 0,
					pct: null,
					kill_threshold_pct: 30,
					kill_triggered: false,
				},
				render_error_48h: {
					renders: 0,
					errors: 0,
					pct: null,
					kill_threshold_pct: 10,
					kill_triggered: false,
				},
			})
		})

		it('computes rich-render and mutation-session percentages from telemetry rows', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// Tool calls: 6 of 10 rich → 60%
			// Sessions: 3 distinct, 2 with mutation → 66.66...%
			// Mutations total: 4
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 10, rich: 6 }],
				[
					{ session_id: 's1', has_mutation: true },
					{ session_id: 's2', has_mutation: false },
					{ session_id: 's3', has_mutation: true },
					{ session_id: null, has_mutation: false },
				],
				[{ total: 4 }],
				[
					{ day: '2026-04-25', total: 4, rich: 2 },
					{ day: '2026-04-26', total: 6, rich: 4 },
				],
				[],
			]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=7', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.tool_calls_total).toBe(10)
			expect(body.tool_calls_rich).toBe(6)
			expect(body.rich_render_pct).toBe(60)
			expect(body.rich_render_target_met).toBe(true)
			expect(body.sessions_total).toBe(3)
			expect(body.sessions_with_mutation).toBe(2)
			expect(body.mutation_session_target_met).toBe(true)
			expect(body.mutations_total).toBe(4)
			expect(body.rich_render_by_day).toHaveLength(2)
			expect(body.rich_render_by_day[0]).toMatchObject({
				day: '2026-04-25',
				tool_calls: 4,
				rich_calls: 2,
				rich_pct: 50,
			})
		})

		it('reports CTR target met with the first-50 kill window cleared', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// 60 bet renders, 20 click_throughs that correlate by (session_id, tool_name, object_id)
			// to the first 20 renders → ctr_first_50 = 20/50 = 40% (target met, kill not triggered).
			// ctr_first_200 over the available 60 = 20/60 ≈ 33.3% (target met).
			const widgetRows = buildBetWidgetRows({ renders: 60, clicksOnFirstN: 20, errors: 0 })
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[],
				widgetRows,
			]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=30', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			const w = body.widget_bet_first_window
			expect(w.bet_renders_total).toBe(60)
			expect(w.bet_click_throughs_total).toBe(20)
			expect(w.ctr_first_50_kill.renders).toBe(50)
			expect(w.ctr_first_50_kill.clicks).toBe(20)
			expect(w.ctr_first_50_kill.pct).toBe(40)
			expect(w.ctr_first_50_kill.kill_triggered).toBe(false)
			expect(w.ctr_first_200.renders).toBe(60)
			expect(w.ctr_first_200.clicks).toBe(20)
			expect(w.ctr_first_200.target_met).toBe(true)
		})

		it('triggers the first-50 kill window when CTR falls below 30%', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// 50 renders, 10 clicks → 20% < 30% threshold → kill_triggered
			const widgetRows = buildBetWidgetRows({ renders: 50, clicksOnFirstN: 10, errors: 0 })
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[],
				widgetRows,
			]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=30', { 'x-workspace-id': wsId }),
			)

			const body = await res.json()
			const w = body.widget_bet_first_window
			expect(w.ctr_first_50_kill.renders).toBe(50)
			expect(w.ctr_first_50_kill.clicks).toBe(10)
			expect(w.ctr_first_50_kill.pct).toBe(20)
			expect(w.ctr_first_50_kill.kill_triggered).toBe(true)
		})

		it('does not trigger the kill window before 50 renders have happened', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// 30 renders, 0 clicks → 0% but only 30 renders → window not full → no kill yet
			const widgetRows = buildBetWidgetRows({ renders: 30, clicksOnFirstN: 0, errors: 0 })
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[],
				widgetRows,
			]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=30', { 'x-workspace-id': wsId }),
			)

			const body = await res.json()
			expect(body.widget_bet_first_window.ctr_first_50_kill.renders).toBe(30)
			expect(body.widget_bet_first_window.ctr_first_50_kill.kill_triggered).toBe(false)
		})

		it('triggers the 48h render-error kill when error rate exceeds 10%', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// 8 renders + 2 errors in the last 48h → 2/10 = 20% > 10%
			const recent = new Date()
			const widgetRows = [
				...Array.from({ length: 8 }, (_, i) => ({
					event: 'render_success',
					session_id: `s${i}`,
					tool_name: 'get_objects',
					object_id: `bet-${i}`,
					created_at: recent,
				})),
				...Array.from({ length: 2 }, (_, i) => ({
					event: 'render_error',
					session_id: `e${i}`,
					tool_name: 'get_objects',
					object_id: `bet-e${i}`,
					created_at: recent,
				})),
			]
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[],
				widgetRows,
			]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=30', { 'x-workspace-id': wsId }),
			)

			const body = await res.json()
			const e = body.widget_bet_first_window.render_error_48h
			expect(e.renders).toBe(8)
			expect(e.errors).toBe(2)
			expect(e.pct).toBe(20)
			expect(e.kill_triggered).toBe(true)
		})

		it('ignores render_error rows older than 48h for the kill window', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			const recent = new Date()
			const stale = new Date(recent.getTime() - 72 * 60 * 60 * 1000) // 72h ago
			const widgetRows = [
				// One stale error (must NOT count) and a fresh successful render.
				{
					event: 'render_error',
					session_id: 'old',
					tool_name: 'get_objects',
					object_id: 'bet-1',
					created_at: stale,
				},
				{
					event: 'render_success',
					session_id: 'new',
					tool_name: 'get_objects',
					object_id: 'bet-2',
					created_at: recent,
				},
			]
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[],
				widgetRows,
			]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=30', { 'x-workspace-id': wsId }),
			)

			const body = await res.json()
			const e = body.widget_bet_first_window.render_error_48h
			expect(e.renders).toBe(1)
			expect(e.errors).toBe(0)
			expect(e.kill_triggered).toBe(false)
		})

		it('persists actor_type on widget_event inserts so agent rows can be filtered later', async () => {
			const { app, mockResults, calls } = createTestApp(
				telemetryRoutes,
				'/api/telemetry',
				'agent-actor-id',
				'agent',
			)
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'widget_event',
						widget_name: 'hero-card',
						event: 'render_success',
						tool_name: 'get_objects',
						session_id: 'mcp-widget-1',
						card_kind: 'single',
						object_type: 'bet',
						object_id: 'bet-123',
						ts: 1717245000000,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
			expect(calls.inserts).toHaveLength(1)
			const inserted = calls.inserts[0] as { data: Record<string, unknown> }
			expect(inserted.data.actor_type).toBe('agent')
		})

		it('returns 403 when the actor is not a workspace member', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = []

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(403)
		})

	})
})

// Builds N synthetic render_success rows that share (session_id, tool_name, object_id)
// with the first M click_through rows so the CTR aggregation correlates them.
// All rows land at the current moment so they fall inside the 48h render-error
// window — sufficient for first-200 / first-50 assertions.
function buildBetWidgetRows({
	renders,
	clicksOnFirstN,
	errors,
}: {
	renders: number
	clicksOnFirstN: number
	errors: number
}) {
	const now = new Date()
	const rows: Array<{
		event: string
		session_id: string
		tool_name: string
		object_id: string
		created_at: Date
	}> = []
	for (let i = 0; i < renders; i++) {
		rows.push({
			event: 'render_success',
			session_id: `s${i}`,
			tool_name: 'get_objects',
			object_id: `bet-${i}`,
			created_at: new Date(now.getTime() + i),
		})
	}
	for (let i = 0; i < clicksOnFirstN; i++) {
		rows.push({
			event: 'click_through',
			session_id: `s${i}`,
			tool_name: 'get_objects',
			object_id: `bet-${i}`,
			created_at: new Date(now.getTime() + renders + i),
		})
	}
	for (let i = 0; i < errors; i++) {
		rows.push({
			event: 'render_error',
			session_id: `e${i}`,
			tool_name: 'get_objects',
			object_id: `bet-e${i}`,
			created_at: new Date(now.getTime() + renders + clicksOnFirstN + i),
		})
	}
	return rows
}
