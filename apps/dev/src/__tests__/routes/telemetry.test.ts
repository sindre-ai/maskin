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
	})

	describe('GET /api/telemetry/mcp/summary', () => {
		it('returns zero counters and zero ratios when no telemetry exists', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// Select order: 1) membership, 2) tool_call totals, 3) sessions group,
			// 4) mutations total, 5) clicks total, 6) tool_call size averages,
			// 7) per-day rows.
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 0, rich: 0 }],
				[],
				[{ total: 0 }],
				[{ total: 0 }],
				[
					{
						samples: 0,
						avg_content_bytes: null,
						avg_content_tokens: null,
						avg_structured_content_bytes: null,
					},
				],
				[],
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
			expect(body.clicks_total).toBe(0)
			expect(body.sessions_with_click).toBe(0)
			expect(body.click_session_pct).toBe(0)
			expect(body.click_session_target_pct).toBe(30)
			expect(body.click_session_target_met).toBe(false)
			expect(body.avg_content_bytes).toBeNull()
			expect(body.avg_content_tokens).toBeNull()
			expect(body.avg_structured_content_bytes).toBeNull()
			expect(body.tool_call_size_samples).toBe(0)
		})

		it('computes rich-render, mutation, click, and token rollups', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			// Tool calls: 6 of 10 rich → 60%
			// Sessions: 3 valid (s1, s2, s3), 2 with mutation, 2 with click → 66.66% each
			// (a session with only deep_link_click + no tool_call is excluded by the HAVING).
			// Avg content bytes 400, tokens 100 (=400/4), structured 1200 across 8 samples.
			mockResults.selectQueue = [
				[memberRow],
				[{ total: 10, rich: 6 }],
				[
					{ session_id: 's1', has_mutation: true, has_click: false },
					{ session_id: 's2', has_mutation: false, has_click: true },
					{ session_id: 's3', has_mutation: true, has_click: true },
					{ session_id: null, has_mutation: false, has_click: false },
				],
				[{ total: 4 }],
				[{ total: 7 }],
				[
					{
						samples: 8,
						avg_content_bytes: '400.0000000000000000',
						avg_content_tokens: '100.0000000000000000',
						avg_structured_content_bytes: '1200.0000000000000000',
					},
				],
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
			// Lean-MCP-results bet additions.
			expect(body.clicks_total).toBe(7)
			expect(body.sessions_with_click).toBe(2)
			expect(body.click_session_pct).toBeCloseTo(66.66666, 1)
			expect(body.click_session_target_met).toBe(true)
			expect(body.avg_content_bytes).toBe(400)
			expect(body.avg_content_tokens).toBe(100)
			expect(body.avg_structured_content_bytes).toBe(1200)
			expect(body.tool_call_size_samples).toBe(8)
		})

		it('accepts a tool_call event with content/token size fields', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'tool_call',
						tool_name: 'list_objects',
						has_rich_render: true,
						duration_ms: 17,
						session_id: 'mcp-test-sized',
						content_bytes: 480,
						content_tokens: 120,
						structured_content_bytes: 5120,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
		})

		it('rejects negative size fields', async () => {
			const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
			mockResults.select = [memberRow]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/telemetry/mcp',
					{
						event_type: 'tool_call',
						tool_name: 'list_objects',
						has_rich_render: false,
						duration_ms: 5,
						content_bytes: -1,
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
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
