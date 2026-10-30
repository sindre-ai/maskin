import { describe, expect, it } from 'vitest'
import { type TelemetryConfig, type TelemetryEvent, recordAliasUse } from '../telemetry'

const target: TelemetryConfig = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	workspaceId: '00000000-0000-0000-0000-0000000000aa',
	sessionId: 'sess-http-1',
	sessionSource: 'maskin-session',
}

function capture() {
	const events: Array<{ event: TelemetryEvent; target: TelemetryConfig }> = []
	return {
		events,
		sink: (event: TelemetryEvent, t: TelemetryConfig) => events.push({ event, target: t }),
	}
}

describe('recordAliasUse', () => {
	it('emits one alias_use event carrying the renames, both_sent and the session', () => {
		const { events, sink } = capture()

		recordAliasUse(sink, target, {
			tool_name: 'update_actor',
			renames: [{ old: 'driver_id', new: 'driver' }],
			both_sent: true,
			transport: 'http',
		})

		expect(events).toHaveLength(1)
		expect(events[0].event).toEqual({
			event_type: 'alias_use',
			tool_name: 'update_actor',
			session_id: 'sess-http-1',
			session_source: 'maskin-session',
			transport: 'http',
			renames: [{ old: 'driver_id', new: 'driver' }],
			both_sent: true,
			dropped_keys: undefined,
			tool_alias: undefined,
		})
	})

	it('uses the call workspace over the default, and the default otherwise', () => {
		const { events, sink } = capture()
		const other = '00000000-0000-0000-0000-0000000000cc'

		recordAliasUse(sink, target, { tool_name: 'get_objects', workspace_id: other })
		recordAliasUse(sink, target, { tool_name: 'get_objects' })

		expect(events[0].target.workspaceId).toBe(other)
		expect(events[1].target.workspaceId).toBe(target.workspaceId)
	})

	it('carries the tool alias and dropped key names for a tool-name alias', () => {
		const { events, sink } = capture()

		recordAliasUse(sink, target, {
			tool_name: 'run_agent',
			dropped_keys: ['config', 'timeout_seconds'],
			tool_alias: { old: 'run_agent', new: 'create_session' },
		})

		expect(events[0].event).toMatchObject({
			tool_name: 'run_agent',
			renames: [],
			both_sent: false,
			dropped_keys: ['config', 'timeout_seconds'],
			tool_alias: { old: 'run_agent', new: 'create_session' },
		})
	})

	it('caps renames at 64 and dropped keys at 16', () => {
		const { events, sink } = capture()

		recordAliasUse(sink, target, {
			tool_name: 'update_objects',
			renames: Array.from({ length: 80 }, (_, i) => ({ old: `old${i}`, new: `new${i}` })),
			dropped_keys: Array.from({ length: 20 }, (_, i) => `k${i}`),
		})

		const event = events[0].event as Extract<TelemetryEvent, { event_type: 'alias_use' }>
		expect(event.renames).toHaveLength(64)
		expect(event.dropped_keys).toHaveLength(16)
	})

	// The ingest boundary validates the whole event, so one odd path would cost
	// the row. Values look like free text; key names never do.
	it('drops paths that do not look like key names instead of sending them', () => {
		const { events, sink } = capture()

		recordAliasUse(sink, target, {
			tool_name: 'update_objects',
			renames: [
				{ old: 'Acquire the Nakatomi account', new: 'title' },
				{ old: 'updates.driver_id', new: 'updates.driver' },
			],
			dropped_keys: ['owner:login', 'config'],
		})

		const event = events[0].event as Extract<TelemetryEvent, { event_type: 'alias_use' }>
		expect(event.renames).toEqual([{ old: 'updates.driver_id', new: 'updates.driver' }])
		expect(event.dropped_keys).toEqual(['config'])
	})
})
