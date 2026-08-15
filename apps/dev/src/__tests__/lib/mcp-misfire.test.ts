import { describe, expect, it, vi } from 'vitest'
import { classifyMcpError, recordMcpMisfire, requestedShape } from '../../lib/analytics/mcp-misfire'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(),
}))

describe('classifyMcpError', () => {
	it('classifies tool-not-found from "Tool X not found"', () => {
		expect(classifyMcpError({ code: -32602, message: 'Tool foo not found' })).toBe('tool_not_found')
	})

	it('classifies tool-not-found from "unknown tool" phrasing', () => {
		expect(classifyMcpError({ code: -32602, message: 'Unknown tool: bar' })).toBe('tool_not_found')
	})

	it('classifies unknown-param from "Unrecognized key"', () => {
		expect(
			classifyMcpError({
				code: -32602,
				message: "Invalid arguments for tool create_objects: Unrecognized key(s) in object: 'foo'",
			}),
		).toBe('unknown_param')
	})

	it('classifies schema-validation for other -32602 errors', () => {
		expect(
			classifyMcpError({ code: -32602, message: 'Invalid arguments for tool: expected string' }),
		).toBe('schema_validation_error')
	})

	it('returns null for InternalError (-32603) and other codes', () => {
		expect(classifyMcpError({ code: -32603, message: 'boom' })).toBeNull()
		expect(classifyMcpError({ code: -32000, message: 'anything' })).toBeNull()
	})

	it('returns null when the error is missing or malformed', () => {
		expect(classifyMcpError(undefined)).toBeNull()
		expect(classifyMcpError({})).toBeNull()
		expect(classifyMcpError({ code: -32602 })).toBeNull()
	})
})

describe('requestedShape', () => {
	it('reduces args to {field: type} without leaking values', () => {
		const shape = requestedShape({
			workspace_id: '00000000-0000-0000-0000-000000000001',
			count: 3,
			active: true,
			meta: { nested: true },
			tags: ['a', 'b'],
			owner: null,
		})
		expect(shape).toEqual({
			workspace_id: 'string',
			count: 'number',
			active: 'boolean',
			meta: 'object',
			tags: 'array',
			owner: 'null',
		})
	})

	it('returns {} for non-object args', () => {
		expect(requestedShape(undefined)).toEqual({})
		expect(requestedShape(null)).toEqual({})
		expect(requestedShape('string')).toEqual({})
		expect(requestedShape([1, 2])).toEqual({})
	})
})

describe('recordMcpMisfire', () => {
	it('persists to mcp_telemetry with event_type=error and never throws on DB failure', async () => {
		const insertValues = vi.fn().mockRejectedValue(new Error('db down'))
		const db = { insert: vi.fn().mockReturnValue({ values: insertValues }) } as never

		await expect(
			recordMcpMisfire(db, '00000000-0000-0000-0000-000000000001', {
				kind: 'tool_not_found',
				toolName: 'imaginary_tool',
				requestedShape: { workspace_id: 'string' },
				sessionId: null,
				agentActorId: 'actor-1',
			}),
		).resolves.toBeUndefined()
		expect(insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: 'error',
				toolName: 'imaginary_tool',
				data: expect.objectContaining({
					kind: 'tool_not_found',
					agent_actor_id: 'actor-1',
					requested_shape: { workspace_id: 'string' },
				}),
			}),
		)
	})

	it('skips the DB write when db is undefined (still fans out to PostHog)', async () => {
		const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
		vi.mocked(capturePosthogEvent).mockClear()

		await recordMcpMisfire(undefined, '00000000-0000-0000-0000-000000000001', {
			kind: 'schema_validation_error',
			toolName: 'create_objects',
			requestedShape: { title: 'string' },
			sessionId: 'mcp-abc',
			agentActorId: 'actor-2',
		})
		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'mcp_misfire_schema_validation_error',
			'actor-2',
			expect.objectContaining({
				tool_name: 'create_objects',
				session_id: 'mcp-abc',
				requested_shape: JSON.stringify({ title: 'string' }),
			}),
		)
	})
})
