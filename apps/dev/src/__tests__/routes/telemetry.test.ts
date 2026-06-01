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

		it('records a widget_event render_success with the full correlation payload', async () => {
			const { app, mockResults, calls } = createTestApp(telemetryRoutes, '/api/telemetry')
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
			expect(calls.inserts).toHaveLength(1)
			expect(calls.inserts[0]).toEqual({
				workspaceId: wsId,
				eventType: 'widget_event',
				toolName: 'get_objects',
				sessionId: 'mcp-widget-1',
				objectType: 'bet',
				data: {
					event: 'render_success',
					widget_name: 'hero-card',
					card_kind: 'single',
					object_id: 'bet-123',
					ts: 1717245000000,
					actor_type: 'human',
				},
			})
		})

		it('records a widget_event click_through with the same correlation tuple as its render_success', async () => {
			const { app, mockResults, calls } = createTestApp(telemetryRoutes, '/api/telemetry')
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
			expect(calls.inserts).toHaveLength(1)
			const inserted = calls.inserts[0] as Record<string, unknown>
			const data = inserted.data as Record<string, unknown>
			// Correlation tuple — must match the render_success row above so T9's
			// CTR query can join click_through back to its parent render.
			expect(inserted.sessionId).toBe('mcp-widget-1')
			expect(inserted.toolName).toBe('get_objects')
			expect(data.object_id).toBe('bet-123')
			expect(data.event).toBe('click_through')
			expect(data.ts).toBe(1717245001000)
			expect(data.actor_type).toBe('human')
		})

		it('records a widget_event render_error so the 48h kill criterion can grep raw logs', async () => {
			const { app, mockResults, calls } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

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

			expect(res.status).toBe(202)
			expect(calls.inserts).toHaveLength(1)
			const data = (calls.inserts[0] as Record<string, unknown>).data as Record<string, unknown>
			expect(data.event).toBe('render_error')
		})

		it('returns 400 when widget_event ts is beyond the year-2100 upper bound', async () => {
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
						session_id: 'mcp-widget-1',
						card_kind: 'single',
						ts: Number.MAX_SAFE_INTEGER,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
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
			// 1) workspace membership check, 2) tool_call totals, 3) sessions group, 4) mutations total, 5) per-day rows
			mockResults.selectQueue = [[memberRow], [{ total: 0, rich: 0 }], [], [{ total: 0 }], []]

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
	})
})
