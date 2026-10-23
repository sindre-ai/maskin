import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// The era labels on the `POST /api/telemetry/mcp` ingest path: stdio tool_call
// fan-out, the response-size event and the client-reported misfire. Two things
// matter and neither shows in the 202: the labels reach the analytics layer
// unchanged, and an older MCP build that sends neither field still gets 202.
const { capturePosthogEvent, captureMcpToolCall, recordMcpMisfire } = vi.hoisted(() => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
	captureMcpToolCall: vi.fn().mockResolvedValue(undefined),
	recordMcpMisfire: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/posthog')>()
	return { ...actual, capturePosthogEvent }
})
vi.mock('../../lib/analytics/mcp-tool-calls', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-tool-calls')>()
	return { ...actual, captureMcpToolCall }
})
vi.mock('../../lib/analytics/mcp-misfire', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-misfire')>()
	return { ...actual, recordMcpMisfire }
})

const { default: telemetryRoutes } = await import('../../routes/telemetry')

const wsId = '00000000-0000-0000-0000-000000000001'
const memberRow = { actorId: 'test-actor-id' }

const toolCallBody = (overrides: Record<string, unknown> = {}) => ({
	event_type: 'tool_call',
	tool_name: 'list_objects',
	has_rich_render: true,
	duration_ms: 42,
	session_id: 'mcp-test-1',
	transport: 'stdio',
	...overrides,
})

const responseSizeBody = (overrides: Record<string, unknown> = {}) => ({
	event_type: 'tool_call_response_size',
	tool_name: 'list_objects',
	session_id: 'mcp-test-1',
	content_bytes: 100,
	content_tokens: 25,
	structured_content_bytes: 900,
	structured_content_tokens: 225,
	truncated: false,
	...overrides,
})

const errorBody = (overrides: Record<string, unknown> = {}) => ({
	event_type: 'error',
	kind: 'tool_not_found',
	tool_name: 'imaginary_tool',
	session_id: 'mcp-test-1',
	...overrides,
})

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

const sizeProps = () =>
	capturePosthogEvent.mock.calls.find((c) => c[0] === 'mcp_tool_call_response_size')?.[2] as
		| Record<string, unknown>
		| undefined

describe('era labels on the ingest route', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capturePosthogEvent.mockResolvedValue(undefined)
		captureMcpToolCall.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
	})

	it('forwards the labels on a stdio tool_call', async () => {
		const res = await post(
			toolCallBody({ mcp_era: 'legacy', mcp_protocol_version: 'none', transport: 'stdio' }),
		)
		expect(res.status).toBe(202)
		expect(captureMcpToolCall.mock.calls[0]?.[1]).toMatchObject({
			mcpEra: 'legacy',
			mcpProtocolVersion: 'none',
		})
	})

	it('forwards the labels on a response-size event', async () => {
		const res = await post(
			responseSizeBody({ mcp_era: 'legacy', mcp_protocol_version: '2025-06-18' }),
		)
		expect(res.status).toBe(202)
		expect(sizeProps()).toMatchObject({ mcp_era: 'legacy', mcp_protocol_version: '2025-06-18' })
	})

	it('forwards the labels on a client-reported misfire', async () => {
		const res = await post(errorBody({ mcp_era: 'modern', mcp_protocol_version: '2026-07-28' }))
		expect(res.status).toBe(202)
		expect(recordMcpMisfire.mock.calls[0]?.[2]).toMatchObject({
			mcpEra: 'modern',
			mcpProtocolVersion: '2026-07-28',
		})
	})

	// The old-build guarantee: neither field present, still accepted, and the
	// labels are absent on the way out rather than defaulted.
	it.each([
		['tool_call', toolCallBody()],
		['tool_call_response_size', responseSizeBody()],
		['error', errorBody()],
	])('accepts an old %s event that sends neither field', async (_name, body) => {
		const res = await post(body)
		expect(res.status).toBe(202)
		expect(captureMcpToolCall.mock.calls[0]?.[1]?.mcpEra).toBeUndefined()
		expect(recordMcpMisfire.mock.calls[0]?.[2]?.mcpEra).toBeUndefined()
		expect(sizeProps()?.mcp_era).toBeUndefined()
	})

	// Degrade, don't reject: an unexpected label must cost the label, not the
	// whole event (and the mcp_telemetry row it rides on).
	it('accepts an unexpected label value and drops just the label', async () => {
		const res = await post(
			toolCallBody({ mcp_era: 'quantum', mcp_protocol_version: 'ank_0123456789abcdef' }),
		)
		expect(res.status).toBe(202)
		const trace = captureMcpToolCall.mock.calls[0]?.[1]
		expect(trace?.mcpEra).toBeUndefined()
		expect(trace?.mcpProtocolVersion).toBeUndefined()
		expect(JSON.stringify(trace)).not.toContain('ank_0123')
	})

	it('ignores unknown extra keys instead of rejecting the event', async () => {
		const res = await post(toolCallBody({ some_future_field: 'x' }))
		expect(res.status).toBe(202)
	})
})
