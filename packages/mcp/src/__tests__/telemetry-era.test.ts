import { describe, expect, it } from 'vitest'
import {
	type TelemetryEvent,
	type TelemetrySink,
	recordToolCall,
	recordToolCallResponseSize,
} from '../telemetry'

// The era labels are decided by `classifyMcpEra` in apps/dev and handed in
// through the telemetry config. This package only stamps them: it must carry
// them on `tool_call` and `tool_call_response_size`, and omit them when the
// host supplied none (stdio fallback aside, an older host never does).
function capture() {
	const events: TelemetryEvent[] = []
	const sink: TelemetrySink = (event) => {
		events.push(event)
	}
	return { events, sink }
}

const target = { apiBaseUrl: 'http://localhost:3000', apiKey: 'ank_x', workspaceId: 'ws' }

describe('era labels in the telemetry sink', () => {
	it('stamps mcp_era and mcp_protocol_version on tool_call', () => {
		const { events, sink } = capture()
		recordToolCall(
			sink,
			{ ...target, mcpEra: 'legacy', mcpProtocolVersion: '2025-06-18' },
			{ tool_name: 'list_objects', has_rich_render: false, duration_ms: 5, transport: 'http' },
		)
		expect(events[0]).toMatchObject({
			event_type: 'tool_call',
			mcp_era: 'legacy',
			mcp_protocol_version: '2025-06-18',
		})
	})

	it('stamps them on tool_call_response_size', () => {
		const { events, sink } = capture()
		recordToolCallResponseSize(
			sink,
			{ ...target, mcpEra: 'legacy', mcpProtocolVersion: 'none' },
			{
				tool_name: 'list_objects',
				content: [],
				structured_content: {},
				truncated: false,
				transport: 'http',
			},
		)
		expect(events[0]).toMatchObject({
			event_type: 'tool_call_response_size',
			mcp_era: 'legacy',
			mcp_protocol_version: 'none',
		})
	})

	it('leaves them off when the host supplied none', () => {
		const { events, sink } = capture()
		recordToolCall(sink, target, {
			tool_name: 'list_objects',
			has_rich_render: false,
			duration_ms: 5,
		})
		// JSON on the wire drops undefined, so an old-shape event has neither key.
		const wire = JSON.parse(JSON.stringify(events[0]))
		expect(wire).not.toHaveProperty('mcp_era')
		expect(wire).not.toHaveProperty('mcp_protocol_version')
	})
})
