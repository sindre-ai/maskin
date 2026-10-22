import { createMcpServer } from '@maskin/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import {
	classifyMcpError,
	recordMcpMisfire,
	redactErrorMessage,
	requestedShape,
} from '../../lib/analytics/mcp-misfire'
import { capturePosthogEvent } from '../../lib/analytics/posthog'

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
				errorMessage: 'Tool imaginary_tool not found',
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
			errorMessage: 'Invalid arguments for tool: expected string',
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

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

// Drive a REAL tool through the real MCP server so the message under test is
// the one the SDK actually produces for a Zod failure, not one we wrote by hand.
// Validation fails before any handler runs, so no API is reached.
async function callToolExpectingValidationError(
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const server = createMcpServer({
		apiBaseUrl: 'http://localhost:0',
		apiKey: 'test',
		defaultWorkspaceId: WORKSPACE_ID,
		telemetrySink: () => {},
	})
	const client = new Client({ name: 'misfire-test', version: '0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(b), client.connect(a)])
	try {
		const res = (await client.callTool({ name, arguments: args })) as {
			isError?: boolean
			content?: Array<{ text?: string }>
		}
		return res.content?.[0]?.text ?? ''
	} catch (err) {
		return err instanceof Error ? err.message : String(err)
	}
}

describe('recordMcpMisfire error_message on a real schema-validation failure', () => {
	it('writes kind and a non-empty error_message to the telemetry row and PostHog', async () => {
		const rawMessage = await callToolExpectingValidationError('get_comments', {
			entity_id: 'not-a-uuid',
			limit: 'lots',
		})
		const error = { code: -32602, message: rawMessage }
		const kind = classifyMcpError(error)
		expect(kind).toBe('schema_validation_error')

		const insertValues = vi.fn().mockResolvedValue(undefined)
		const db = { insert: vi.fn().mockReturnValue({ values: insertValues }) } as never
		vi.mocked(capturePosthogEvent).mockClear()

		await recordMcpMisfire(db, WORKSPACE_ID, {
			kind: kind as NonNullable<typeof kind>,
			toolName: 'get_comments',
			requestedShape: requestedShape({ entity_id: 'not-a-uuid', limit: 'lots' }),
			errorMessage: error.message,
			sessionId: null,
			agentActorId: 'actor-1',
		})

		const row = insertValues.mock.calls[0]?.[0] as { data: { kind: string; error_message: string } }
		expect(row.data.kind).toBe('schema_validation_error')
		expect(row.data.error_message.length).toBeGreaterThan(0)
		// Path and expected-type text survive: that is the signal.
		expect(row.data.error_message).toContain('entity_id')
		expect(row.data.error_message).toContain('limit: invalid_type expected number')

		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'mcp_misfire_schema_validation_error',
			'actor-1',
			expect.objectContaining({
				kind: 'schema_validation_error',
				error_message: row.data.error_message,
			}),
		)
	})

	it('never lets a failing input value into error_message', async () => {
		const secret = 'SECRET-ENUM-VALUE-d41d8cd9'
		const rawMessage = await callToolExpectingValidationError('list_files', { kind: secret })
		// Guard against a vacuous pass: the raw SDK message really does echo it.
		expect(rawMessage).toContain(secret)

		const insertValues = vi.fn().mockResolvedValue(undefined)
		const db = { insert: vi.fn().mockReturnValue({ values: insertValues }) } as never
		vi.mocked(capturePosthogEvent).mockClear()

		await recordMcpMisfire(db, WORKSPACE_ID, {
			kind: 'schema_validation_error',
			toolName: 'list_files',
			requestedShape: requestedShape({ kind: secret }),
			errorMessage: rawMessage,
			sessionId: null,
			agentActorId: 'actor-1',
		})

		const row = insertValues.mock.calls[0]?.[0] as { data: { error_message: string } }
		expect(row.data.error_message).toContain('kind: invalid_enum_value expected one of briefing')
		expect(row.data.error_message).not.toContain(secret)
		const props = vi.mocked(capturePosthogEvent).mock.calls[0]?.[2] as { error_message: string }
		expect(props.error_message).not.toContain(secret)
		expect(JSON.stringify(vi.mocked(capturePosthogEvent).mock.calls)).not.toContain(secret)
	})
})

describe('redactErrorMessage', () => {
	it('caps the result at 500 characters', () => {
		const issues = Array.from({ length: 60 }, (_, i) => ({
			code: 'invalid_type',
			expected: 'string',
			received: 'number',
			path: [`field_${i}`],
		}))
		expect(redactErrorMessage(JSON.stringify(issues)).length).toBe(500)
	})

	it('masks a path segment that is not a plain field name', () => {
		const raw = JSON.stringify([
			{ code: 'invalid_type', expected: 'string', received: 'number', path: ['meta', 'a b@c.com'] },
		])
		expect(redactErrorMessage(raw)).toBe(
			'meta.<key>: invalid_type expected string, received number',
		)
	})

	it('drops a quoted received value and ids from free-text messages', () => {
		const out = redactErrorMessage(
			"Expected 'a' | 'b', received 'leaked' for 123e4567-e89b-12d3-a456-426614174000",
		)
		expect(out).not.toContain('leaked')
		expect(out).not.toContain('123e4567')
	})

	it('passes a plain tool-not-found message through unchanged', () => {
		const msg = 'Tool imaginary_tool not found'
		expect(redactErrorMessage(msg)).toBe(msg)
	})
})
