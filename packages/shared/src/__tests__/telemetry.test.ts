import { describe, expect, it } from 'vitest'
import {
	alignTopFields,
	listCallObjectType,
	recordMcpAliasUseSchema,
	recordMcpTelemetrySchema,
	recordMcpToolCallResponseSizeSchema,
	recordMcpToolCallSchema,
} from '../schemas/telemetry'

function baseEvent(overrides: Record<string, unknown> = {}) {
	return {
		event_type: 'tool_call' as const,
		tool_name: 'list_objects',
		session_id: 'session-1',
		has_rich_render: true,
		duration_ms: 42,
		...overrides,
	}
}

describe('listCallObjectType', () => {
	it('returns the fixed type for the four tools that list one thing', () => {
		expect(listCallObjectType('list_triggers', {})).toBe('trigger')
		expect(listCallObjectType('list_loops', { cursor: 'abc' })).toBe('loop')
		expect(listCallObjectType('list_workspace_skills', undefined)).toBe('skill')
		expect(listCallObjectType('list_extensions', null)).toBe('extension')
	})

	it('passes a built-in type through for list_objects and search_objects', () => {
		expect(listCallObjectType('list_objects', { type: 'task' })).toBe('task')
		expect(listCallObjectType('search_objects', { type: 'insight', query: 'x' })).toBe('insight')
	})

	it('records none when no type was passed', () => {
		expect(listCallObjectType('list_objects', {})).toBe('none')
		expect(listCallObjectType('search_objects', { query: 'x' })).toBe('none')
		expect(listCallObjectType('list_objects', undefined)).toBe('none')
		expect(listCallObjectType('list_objects', { type: '' })).toBe('none')
	})

	// A custom type name or free text is workspace-authored: it must collapse to
	// the literal `other` and never reach analytics.
	it('collapses a custom type, free text or a non-string to other', () => {
		expect(listCallObjectType('list_objects', { type: 'quarterly_okr' })).toBe('other')
		expect(listCallObjectType('search_objects', { type: 'Acquire the Nakatomi account' })).toBe(
			'other',
		)
		expect(listCallObjectType('list_objects', { type: 'Task' })).toBe('other')
		expect(listCallObjectType('list_objects', { type: ['task'] })).toBe('other')
		expect(listCallObjectType('list_objects', { type: 7 })).toBe('other')
	})

	it('ignores the type argument on the fixed-type tools', () => {
		expect(listCallObjectType('list_triggers', { type: 'secret text' })).toBe('trigger')
	})

	it('is undefined for every other tool', () => {
		expect(listCallObjectType('get_objects', { type: 'task' })).toBeUndefined()
		expect(listCallObjectType('create_objects', {})).toBeUndefined()
	})
})

describe('recordMcpToolCallSchema — object_type', () => {
	it('accepts a value from the fixed set', () => {
		expect(recordMcpToolCallSchema.parse(baseEvent({ object_type: 'bet' })).object_type).toBe('bet')
		expect(recordMcpToolCallSchema.parse(baseEvent({ object_type: 'other' })).object_type).toBe(
			'other',
		)
	})

	it('is absent from an older build without failing the row', () => {
		expect(recordMcpToolCallSchema.parse(baseEvent()).object_type).toBeUndefined()
	})

	it('degrades free text to undefined instead of rejecting the row', () => {
		const parsed = recordMcpToolCallSchema.parse(
			baseEvent({ object_type: 'Acquire the Nakatomi account' }),
		)
		expect(parsed.object_type).toBeUndefined()
		expect(parsed.tool_name).toBe('list_objects')
	})
})

describe('recordMcpToolCallSchema — arg_keys', () => {
	it('accepts identifier-like keys', () => {
		const parsed = recordMcpToolCallSchema.parse(
			baseEvent({ arg_keys: ['limit', 'type', 'workspace_id'] }),
		)
		expect(parsed.arg_keys).toEqual(['limit', 'type', 'workspace_id'])
	})

	// The critical property: `arg_keys` is optional analytics riding on an event
	// whose primary payload is the pre-existing mcp_telemetry row. A bad key must
	// cost us the key list only. If this ever throws again, a custom-extension
	// tool with an unusual param name silently loses its telemetry row entirely,
	// because validation runs before the route handler.
	it('drops a malformed key list instead of rejecting the whole event', () => {
		for (const bad of [
			['Acquire the Nakatomi account'],
			['owner:login'],
			['a'.repeat(65)],
			Array.from({ length: 65 }, (_, i) => `k${i}`),
			'not-an-array',
			[123],
		]) {
			const parsed = recordMcpToolCallSchema.parse(baseEvent({ arg_keys: bad }))
			expect(parsed.arg_keys).toEqual([])
			// The fields the row actually depends on survive untouched.
			expect(parsed.tool_name).toBe('list_objects')
			expect(parsed.has_rich_render).toBe(true)
			expect(parsed.duration_ms).toBe(42)
		}
	})

	it('still rejects the event when a load-bearing field is invalid', () => {
		// `.catch` on arg_keys must not have made the whole schema permissive.
		expect(() => recordMcpToolCallSchema.parse(baseEvent({ tool_name: 'bad name!' }))).toThrow()
		expect(() => recordMcpToolCallSchema.parse(baseEvent({ duration_ms: -1 }))).toThrow()
	})
})

describe('alignTopFields', () => {
	it('keeps the pair when the two arrays line up', () => {
		expect(alignTopFields(['data', 'title'], [900, 40])).toEqual({
			topFields: ['data', 'title'],
			topFieldBytes: [900, 40],
		})
	})

	it('drops both when only the names survive validation', () => {
		// The real path: `top_fields` and `top_field_bytes` each carry their own
		// `.catch([])`, so one can degrade without the other. Eight names beside
		// zero byte counts is worse than nothing — a dashboard joining them by
		// position would attribute a confident, wrong size to every field.
		const parsed = recordMcpToolCallResponseSizeSchema.parse({
			event_type: 'tool_call_response_size',
			tool_name: 'list_objects',
			session_id: 'session-1',
			content_bytes: 10,
			content_tokens: 2,
			structured_content_bytes: 900,
			structured_content_tokens: 220,
			truncated: false,
			top_fields: ['data', 'title'],
			// A negative byte count fails validation and degrades to [].
			top_field_bytes: [900, -1],
		})
		expect(parsed.top_field_bytes).toEqual([])
		expect(alignTopFields(parsed.top_fields, parsed.top_field_bytes)).toEqual({
			topFields: [],
			topFieldBytes: [],
		})
	})

	it('treats an absent array as empty rather than throwing', () => {
		expect(alignTopFields(undefined, undefined)).toEqual({ topFields: [], topFieldBytes: [] })
		// An older producer sending names but no sizes is still misaligned.
		expect(alignTopFields(['data'], undefined)).toEqual({ topFields: [], topFieldBytes: [] })
	})
})

describe('era labels on the ingest schemas', () => {
	const sizeEvent = {
		event_type: 'tool_call_response_size' as const,
		tool_name: 'list_objects',
		content_bytes: 1,
		content_tokens: 1,
		structured_content_bytes: 1,
		structured_content_tokens: 1,
		truncated: false,
	}

	it('accepts optional mcp_era and mcp_protocol_version on tool_call and response size', () => {
		const call = recordMcpToolCallSchema.parse(
			baseEvent({ mcp_era: 'legacy', mcp_protocol_version: '2025-06-18' }),
		)
		expect(call.mcp_era).toBe('legacy')
		expect(call.mcp_protocol_version).toBe('2025-06-18')
		const size = recordMcpToolCallResponseSizeSchema.parse({
			...sizeEvent,
			mcp_era: 'modern',
			mcp_protocol_version: '2026-07-28',
		})
		expect(size.mcp_era).toBe('modern')
		expect(size.mcp_protocol_version).toBe('2026-07-28')
	})

	it('accepts the error event with labels', () => {
		const parsed = recordMcpTelemetrySchema.parse({
			event_type: 'error',
			kind: 'tool_not_found',
			tool_name: 'imaginary_tool',
			mcp_era: 'legacy',
			mcp_protocol_version: 'none',
		})
		expect(parsed).toMatchObject({ mcp_era: 'legacy', mcp_protocol_version: 'none' })
	})

	it('still validates an old event that sends neither field', () => {
		const call = recordMcpToolCallSchema.parse(baseEvent())
		expect(call.mcp_era).toBeUndefined()
		expect(call.mcp_protocol_version).toBeUndefined()
		expect(recordMcpToolCallResponseSizeSchema.safeParse(sizeEvent).success).toBe(true)
	})

	// Same stance as arg_keys: an odd value costs the label, never the row.
	it('drops an out-of-set value instead of failing the parse', () => {
		const result = recordMcpToolCallSchema.safeParse(
			baseEvent({ mcp_era: 'quantum', mcp_protocol_version: '1999-01-01' }),
		)
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.mcp_era).toBeUndefined()
			expect(result.data.mcp_protocol_version).toBeUndefined()
		}
	})

	it('is not strict about unknown keys', () => {
		expect(recordMcpToolCallSchema.safeParse(baseEvent({ some_future_field: 1 })).success).toBe(
			true,
		)
	})
})

describe('recordMcpToolCallResponseSizeSchema — view', () => {
	const sizeEvent = (overrides: Record<string, unknown> = {}) => ({
		event_type: 'tool_call_response_size' as const,
		tool_name: 'list_actors',
		session_id: 'session-1',
		content_bytes: 10,
		content_tokens: 2,
		structured_content_bytes: 900,
		structured_content_tokens: 220,
		truncated: false,
		...overrides,
	})

	it.each(['slim', 'full'])('accepts view=%s', (view) => {
		expect(recordMcpToolCallResponseSizeSchema.parse(sizeEvent({ view })).view).toBe(view)
	})

	it('leaves view undefined when the producer omits it', () => {
		expect(recordMcpToolCallResponseSizeSchema.parse(sizeEvent()).view).toBeUndefined()
	})

	it('drops a free-text view instead of rejecting the event', () => {
		const parsed = recordMcpToolCallResponseSizeSchema.parse(
			sizeEvent({ view: 'Acquire the Nakatomi account' }),
		)
		expect(parsed.view).toBeUndefined()
		expect(parsed.structured_content_bytes).toBe(900)
	})
})

describe('recordMcpTelemetrySchema — alias_use', () => {
	const aliasEvent = (overrides: Record<string, unknown> = {}) => ({
		event_type: 'alias_use' as const,
		tool_name: 'update_actor',
		session_id: 'session-1',
		session_source: 'maskin-session' as const,
		transport: 'http' as const,
		renames: [{ old: 'driver_id', new: 'driver' }],
		both_sent: false,
		...overrides,
	})

	it('accepts a key-rename event and leaves tool_alias absent', () => {
		const parsed = recordMcpTelemetrySchema.parse(aliasEvent())
		expect(parsed).toMatchObject({
			event_type: 'alias_use',
			tool_name: 'update_actor',
			renames: [{ old: 'driver_id', new: 'driver' }],
			both_sent: false,
		})
		expect('tool_alias' in parsed ? parsed.tool_alias : undefined).toBeUndefined()
	})

	it('accepts nested dotted paths', () => {
		const parsed = recordMcpAliasUseSchema.parse(
			aliasEvent({ renames: [{ old: 'config.maxTurns', new: 'config.max_turns' }] }),
		)
		expect(parsed.renames[0]).toEqual({ old: 'config.maxTurns', new: 'config.max_turns' })
	})

	it('accepts a tool-name alias with dropped key names', () => {
		const parsed = recordMcpAliasUseSchema.parse(
			aliasEvent({
				tool_name: 'run_agent',
				renames: [],
				tool_alias: { old: 'run_agent', new: 'create_session' },
				dropped_keys: ['config', 'poll_interval_seconds'],
			}),
		)
		expect(parsed.tool_alias).toEqual({ old: 'run_agent', new: 'create_session' })
		expect(parsed.dropped_keys).toEqual(['config', 'poll_interval_seconds'])
	})

	it('defaults renames to empty and both_sent to false', () => {
		const parsed = recordMcpAliasUseSchema.parse({
			event_type: 'alias_use',
			tool_name: 'run_agent',
		})
		expect(parsed.renames).toEqual([])
		expect(parsed.both_sent).toBe(false)
	})

	it('caps renames at 64 and dropped keys at 16', () => {
		const rename = { old: 'a', new: 'b' }
		expect(
			recordMcpAliasUseSchema.safeParse(aliasEvent({ renames: Array(64).fill(rename) })).success,
		).toBe(true)
		expect(
			recordMcpAliasUseSchema.safeParse(aliasEvent({ renames: Array(65).fill(rename) })).success,
		).toBe(false)
		expect(
			recordMcpAliasUseSchema.safeParse(aliasEvent({ dropped_keys: Array(17).fill('k') })).success,
		).toBe(false)
	})

	// The contract is key NAMES. A path with spaces or punctuation is what a
	// value (free text) looks like, so it must not get through.
	it('rejects a rename path that is not identifier-like', () => {
		for (const bad of ['Acquire the Nakatomi account', 'owner:login', 'a'.repeat(65), '']) {
			expect(
				recordMcpAliasUseSchema.safeParse(aliasEvent({ renames: [{ old: bad, new: 'driver' }] }))
					.success,
			).toBe(false)
		}
	})

	it('has no actor field: an actor id in the payload is stripped', () => {
		const parsed = recordMcpAliasUseSchema.parse(aliasEvent({ agent_actor_id: 'someone-else' }))
		expect('agent_actor_id' in parsed).toBe(false)
	})

	it('is a member of the discriminated telemetry union', () => {
		expect(recordMcpTelemetrySchema.safeParse(aliasEvent()).success).toBe(true)
	})
})
