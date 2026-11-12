import { describe, expect, it } from 'vitest'
import { classifyMcpError } from '../../lib/analytics/mcp-misfire'
import { classifyMcpToolError } from '../../lib/analytics/mcp-tool-error-class'

const asError = (message: string) => ({ message })

describe('classifyMcpToolError', () => {
	it.each([
		['API error 403: Session was started by a different actor', 'permission_denied'],
		['API error 401: Unauthorized', 'permission_denied'],
		['API error 404: Object not found', 'not_found'],
		['API error 429: Too many requests', 'rate_limited'],
		['API error 502: Bad gateway', 'upstream_error'],
		[
			'update_objects wrote nothing: it received no updates and no edges. Nothing was written.',
			'guard_refusal',
		],
	])('buckets %s as %s', (message, expected) => {
		expect(classifyMcpToolError(asError(message))).toBe(expected)
	})

	it('leaves other 4xx statuses and unrecognised text unclassified', () => {
		expect(classifyMcpToolError(asError('API error 409: Conflict'))).toBeNull()
		expect(classifyMcpToolError(asError('something else broke'))).toBeNull()
		expect(classifyMcpToolError(undefined)).toBeNull()
		expect(classifyMcpToolError({})).toBeNull()
	})

	it('does not take over what the protocol classifier already names', () => {
		const validation = asError('Input validation error: Invalid arguments for tool x')
		expect(classifyMcpError({ code: -32602, message: validation.message })).toBe(
			'schema_validation_error',
		)
		expect(classifyMcpToolError(validation)).toBeNull()
	})
})
