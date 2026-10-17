import { describe, expect, it } from 'vitest'
import { classifyMcpError } from '../../lib/analytics/mcp-misfire'
import { type JsonRpcMessage, extractError } from '../../routes/mcp'
import { type LegacyTranscript, loadLegacyTranscripts } from '../mcp-legacy-harness'

// The misfire classifier feeds the schema-error metric, and it matches on the
// wording the SDK puts in its error text. These tests run it over the REAL
// text SDK v1 produced, recorded from v1 main into
// packages/mcp/src/__tests__/fixtures/legacy-v1/, so a wording change that
// stops a class from classifying shows up here instead of as a quiet drop in
// the metric.
//
// HELD: the same three classes on the real SDK v2 text, and the replay over the
// v1 and v2 sets together, wait for the spike task's saved v2 output
// (packages/mcp/src/__tests__/fixtures/sdk-v2/). No test here uses predicted v2
// wording.

const transcripts = new Map(loadLegacyTranscripts().map((t) => [t.name, t]))

function responseMessage(name: string): JsonRpcMessage {
	const transcript = transcripts.get(name) as LegacyTranscript
	return JSON.parse(transcript.response.body) as JsonRpcMessage
}

describe('misfire classification on recorded SDK v1 text', () => {
	it.each([
		['tools-call-unknown-tool', 'tool_not_found'],
		['tools-call-bad-argument', 'schema_validation_error'],
		['tools-call-unrecognized-key', 'unknown_param'],
	])('classifies %s as %s', (name, expectedKind) => {
		const error = extractError(responseMessage(name))

		expect(classifyMcpError(error)).toBe(expectedKind)
	})

	it('reads the -32602 code out of the v1 "MCP error" prefix for all three classes', () => {
		for (const name of [
			'tools-call-unknown-tool',
			'tools-call-bad-argument',
			'tools-call-unrecognized-key',
		]) {
			expect(extractError(responseMessage(name))?.code).toBe(-32602)
		}
	})

	it('reports no error for a successful tool call', () => {
		expect(extractError(responseMessage('tools-call-ok'))).toBeUndefined()
	})

	it('leaves no recorded v1 error unclassified', () => {
		// The malformed-json reply is the route's own 400, not a reply from the
		// SDK, and the route never feeds it to the classifier.
		const errors = [...transcripts.values()]
			.filter((t) => t.name !== 'malformed-json')
			.filter((t) => t.response.contentType?.startsWith('application/json'))
			.map((t) => JSON.parse(t.response.body) as JsonRpcMessage | JsonRpcMessage[])
			.flatMap((body) => (Array.isArray(body) ? body : [body]))
			.map((message) => extractError(message))
			.filter((error) => error !== undefined)

		// The replay set: three tool errors, and nothing else in it is an error.
		expect(errors).toHaveLength(3)
		const unclassified = errors.filter((error) => classifyMcpError(error) === null)
		expect(unclassified).toHaveLength(0)
	})
})
