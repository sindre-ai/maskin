import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// The `tool_call_response_size` branch of `POST /api/telemetry/mcp`. It is
// PostHog-only — no DB row — so nothing about it is observable from the
// response, which is 202 either way. These tests pin the fan-out payload,
// because a dropped or mislabelled dimension here shows up as a dashboard that
// quietly answers the wrong question rather than as a failure.
const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/posthog')>()
	return { ...actual, capturePosthogEvent }
})

const { default: telemetryRoutes } = await import('../../routes/telemetry')

const wsId = '00000000-0000-0000-0000-000000000001'
const memberRow = { actorId: 'test-actor-id' }

function baseBody(overrides: Record<string, unknown> = {}) {
	return {
		event_type: 'tool_call_response_size',
		tool_name: 'list_objects',
		session_id: 'mcp-test-1',
		content_bytes: 100,
		content_tokens: 25,
		structured_content_bytes: 900,
		structured_content_tokens: 225,
		truncated: false,
		...overrides,
	}
}

async function post(body: Record<string, unknown>) {
	const { app, mockResults } = createTestApp(telemetryRoutes, '/api/telemetry')
	mockResults.select = [memberRow]
	mockResults.insert = [{}]
	const res = await app.request(
		jsonRequest('POST', '/api/telemetry/mcp', body, { 'x-workspace-id': wsId }),
	)
	await new Promise((r) => setImmediate(r))
	return res
}

/** Props of the most recent `mcp_tool_call_response_size` capture. */
function lastProps(): Record<string, unknown> {
	const calls = capturePosthogEvent.mock.calls.filter((c) => c[0] === 'mcp_tool_call_response_size')
	return calls[calls.length - 1]?.[2] as Record<string, unknown>
}

describe('response-size fan-out', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capturePosthogEvent.mockResolvedValue(undefined)
	})

	it('forwards the shape dimensions', async () => {
		const res = await post(
			baseBody({
				seq: 4,
				arg_keys: ['limit', 'type'],
				row_count: 50,
				max_row_bytes: 400,
				content_block_count: 1,
				top_fields: ['content', 'title'],
				top_field_bytes: [700, 120],
			}),
		)

		expect(res.status).toBe(202)
		expect(lastProps()).toMatchObject({
			tool_name: 'list_objects',
			seq: 4,
			arg_keys: ['limit', 'type'],
			row_count: 50,
			max_row_bytes: 400,
			content_block_count: 1,
			top_fields: ['content', 'title'],
			top_field_bytes: [700, 120],
		})
	})

	it('derives bytes_per_row and the totals', async () => {
		// Derived at ingest, not in the dashboard, so "are the rows too fat?"
		// is answerable by grouping alone.
		await post(baseBody({ row_count: 9 }))
		expect(lastProps().bytes_per_row).toBe(100)
		expect(lastProps().total_bytes).toBe(1000)
		expect(lastProps().total_tokens).toBe(250)
	})

	it('reports bytes_per_row null for a zero row count rather than dividing by zero', async () => {
		await post(baseBody({ row_count: 0 }))
		expect(lastProps().bytes_per_row).toBeNull()
	})

	it('sends null shape dimensions when an older client omits them', async () => {
		// Null, not 0: a tool that carries no row array is not a tool that
		// returned zero rows, and collapsing the two skews every average.
		await post(baseBody())
		expect(lastProps()).toMatchObject({
			seq: null,
			row_count: null,
			max_row_bytes: null,
			content_block_count: null,
			top_fields: [],
			top_field_bytes: [],
			bytes_per_row: null,
		})
	})

	it('drops non-identifier field names instead of rejecting the event', async () => {
		// `top_fields` degrades the same way `arg_keys` does — a name the regex
		// rejects must cost the name, not the byte totals riding with it.
		const res = await post(baseBody({ top_fields: ['Acquire the Nakatomi account'] }))
		expect(res.status).toBe(202)
		expect(lastProps().top_fields).toEqual([])
		expect(lastProps().total_bytes).toBe(1000)
	})

	it('never forwards a misaligned name/byte pair', async () => {
		// The two arrays validate independently, so one can degrade and leave
		// the other intact. Forwarding that half-pair would let a dashboard
		// join them by position and report the wrong size for every field —
		// so the ranking is aligned-or-nothing.
		const res = await post(
			baseBody({
				top_fields: ['Acquire the Nakatomi account', 'data'],
				top_field_bytes: [900, 40],
			}),
		)
		expect(res.status).toBe(202)
		expect(lastProps()).toMatchObject({ top_fields: [], top_field_bytes: [] })
	})

	it('forwards an aligned name/byte pair intact', async () => {
		const res = await post(baseBody({ top_fields: ['data', 'title'], top_field_bytes: [900, 40] }))
		expect(res.status).toBe(202)
		expect(lastProps()).toMatchObject({
			top_fields: ['data', 'title'],
			top_field_bytes: [900, 40],
		})
	})
})
