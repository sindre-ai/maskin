import { describe, expect, it } from 'vitest'
import {
	alignTopFields,
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
