import { recordMcpToolCallResponseSizeSchema, recordMcpToolCallSchema } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { buildOpenAPIDocument } from '../openapi'

describe('buildOpenAPIDocument', () => {
	// A single schema the generator can't map (a `.catch()`, say) makes the whole
	// document throw, which breaks /api/openapi.json and every SDK
	// generated from it (the native clients included).
	it('generates an OpenAPI 3.1 document for every documented route', () => {
		const doc = buildOpenAPIDocument() as { openapi: string; paths: Record<string, unknown> }

		expect(doc.openapi).toMatch(/^3\.1/)
		expect(Object.keys(doc.paths)).toContain('/api/telemetry/mcp')
	})
})

describe('telemetry degrade-to-empty fields', () => {
	const toolCall = {
		event_type: 'tool_call',
		tool_name: 'list_objects',
		has_rich_render: false,
		duration_ms: 12,
	}
	const responseSize = {
		event_type: 'tool_call_response_size',
		tool_name: 'list_objects',
		content_bytes: 1,
		content_tokens: 1,
		structured_content_bytes: 1,
		structured_content_tokens: 1,
		truncated: false,
	}

	it('drops an invalid arg_keys list instead of rejecting the event', () => {
		const parsed = recordMcpToolCallSchema.parse({ ...toolCall, arg_keys: ['has space'] })

		expect(parsed.arg_keys).toEqual([])
	})

	it('keeps arg_keys absent when the producer omits it', () => {
		const parsed = recordMcpToolCallSchema.parse(toolCall)

		expect(parsed.arg_keys).toBeUndefined()
	})

	it('drops top_fields and top_field_bytes independently when invalid', () => {
		const parsed = recordMcpToolCallResponseSizeSchema.parse({
			...responseSize,
			top_fields: ['bad name!'],
			top_field_bytes: [10, 20],
		})

		expect(parsed.top_fields).toEqual([])
		expect(parsed.top_field_bytes).toEqual([10, 20])
	})
})
