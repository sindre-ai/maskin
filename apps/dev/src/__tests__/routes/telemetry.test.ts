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
			// 1) workspace membership, 2) tool_call totals, 3) sessions group,
			// 4) mutations total, 5) per-day rows, 6) widget render-error rows
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[],
				[{ renders: 0, errors: 0 }],
			]

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
			expect(body.widget_renders_48h).toBe(0)
			expect(body.widget_render_errors_48h).toBe(0)
			expect(body.render_error_pct_48h).toBe(0)
			expect(body.render_error_kill_switch_pct).toBe(10)
			expect(body.render_error_kill_switch_breach).toBe(false)
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
				[{ renders: 0, errors: 0 }],
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

		it('returns 403 when the actor is not a workspace member', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = []

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(403)
		})

		it('flags the kill-switch breach when widget render-error rate exceeds 10% in the 48h window', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// 100 widget renders in the 48h window, 15 errors → 15% → breach.
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[],
				[{ renders: 100, errors: 15 }],
			]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=30', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.widget_renders_48h).toBe(100)
			expect(body.widget_render_errors_48h).toBe(15)
			expect(body.render_error_pct_48h).toBe(15)
			expect(body.render_error_kill_switch_breach).toBe(true)
		})

		it('does not flag the kill-switch breach when render-error rate is within tolerance', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// 100 widget renders in the 48h window, 5 errors → 5% → no breach.
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[],
				[{ renders: 100, errors: 5 }],
			]

			const res = await app.request(
				jsonGet('/api/telemetry/mcp/summary?days=30', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.render_error_pct_48h).toBe(5)
			expect(body.render_error_kill_switch_breach).toBe(false)
		})
	})
})
