import { readFileSync, readdirSync } from 'node:fs'
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
// The same three classes are then run over the REAL SDK v2 text the spike task
// saved into packages/mcp/src/__tests__/fixtures/sdk-v2/ (legacy and modern
// leg), and a replay over both sets asserts v2 leaves no more bad-argument or
// unknown-tool errors unclassified than v1 did. No test here uses predicted v2
// wording.

const transcripts = new Map(loadLegacyTranscripts().map((t) => [t.name, t]))

const V2_FIXTURES_DIR = new URL(
	'../../../../../packages/mcp/src/__tests__/fixtures/sdk-v2/',
	import.meta.url,
)

interface V2Fixture {
	name: string
	response: { status: number; contentType: string | null; body: string }
}

const v2Fixtures: V2Fixture[] = readdirSync(V2_FIXTURES_DIR)
	.filter((file) => file.endsWith('.json'))
	.sort()
	.map((file) => JSON.parse(readFileSync(new URL(file, V2_FIXTURES_DIR), 'utf8')))

function v2Error(name: string) {
	const fixture = v2Fixtures.find((f) => f.name === name)
	if (!fixture) throw new Error(`missing sdk-v2 fixture: ${name}`)
	return extractError(JSON.parse(fixture.response.body) as JsonRpcMessage)
}

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

describe('misfire classification on recorded SDK v2 text', () => {
	// Both protocol eras answer with the same error text, so each class is
	// asserted on the legacy leg and on the modern leg.
	it.each([
		['legacy-tools-call-bad-argument', 'schema_validation_error'],
		['modern-tools-call-bad-argument', 'schema_validation_error'],
		['legacy-tools-call-unrecognized-key', 'unknown_param'],
		['modern-tools-call-unrecognized-key', 'unknown_param'],
		['legacy-tools-call-unknown-tool', 'tool_not_found'],
		['modern-tools-call-unknown-tool', 'tool_not_found'],
	])('classifies %s as %s', (name, expectedKind) => {
		expect(classifyMcpError(v2Error(name))).toBe(expectedKind)
	})

	it('reads v2 bad-argument text with no "MCP error -32602" prefix as InvalidParams', () => {
		for (const name of [
			'legacy-tools-call-bad-argument',
			'modern-tools-call-bad-argument',
			'legacy-tools-call-unrecognized-key',
			'modern-tools-call-unrecognized-key',
		]) {
			const error = v2Error(name)
			expect(error?.message).not.toContain('MCP error')
			expect(error?.code).toBe(-32602)
		}
	})

	it('reads v2 unknown tool as a top-level JSON-RPC error, not an in-band tool result', () => {
		for (const name of ['legacy-tools-call-unknown-tool', 'modern-tools-call-unknown-tool']) {
			const fixture = v2Fixtures.find((f) => f.name === name)
			const body = JSON.parse(fixture?.response.body ?? '{}') as JsonRpcMessage
			expect(body.result).toBeUndefined()
			expect(body.error).toEqual({ code: -32602, message: 'Tool no_such_tool not found' })
			expect(extractError(body)).toEqual(body.error)
		}
	})

	it('keeps a handler throw unclassified', () => {
		// A tool's own failure is not a misfire, so the hardening must not pull it
		// into one of the three named kinds.
		for (const name of ['legacy-tools-call-handler-throw', 'modern-tools-call-handler-throw']) {
			const error = v2Error(name)
			expect(error?.message).toBe('handler exploded: upstream API returned 500')
			expect(classifyMcpError(error)).toBeNull()
		}
	})
})

describe('unclassified share across the recorded v1 and v2 sets', () => {
	const misfireCases = [
		['bad argument', 'tools-call-bad-argument'],
		['unrecognized key', 'tools-call-unrecognized-key'],
		['unknown tool', 'tools-call-unknown-tool'],
	] as const

	function unclassifiedCount(errors: Array<ReturnType<typeof extractError>>) {
		return errors.filter((error) => classifyMcpError(error) === null).length
	}

	it('does not rise from v1 to v2 for the same three misfires', () => {
		const v1 = misfireCases.map(([, name]) => extractError(responseMessage(name)))
		const v2Legacy = misfireCases.map(([, name]) => v2Error(`legacy-${name}`))
		const v2Modern = misfireCases.map(([, name]) => v2Error(`modern-${name}`))

		// Every one of these is a real error in both SDK versions.
		for (const errors of [v1, v2Legacy, v2Modern]) {
			expect(errors.every((error) => error !== undefined)).toBe(true)
		}
		const v1Share = unclassifiedCount(v1) / v1.length
		expect(v1Share).toBe(0)
		expect(unclassifiedCount(v2Legacy) / v2Legacy.length).toBeLessThanOrEqual(v1Share)
		expect(unclassifiedCount(v2Modern) / v2Modern.length).toBeLessThanOrEqual(v1Share)
	})

	it('classifies every recorded v2 error except the handler throws', () => {
		const unclassified = v2Fixtures
			.filter((f) => f.response.contentType?.startsWith('application/json'))
			.filter((f) => extractError(JSON.parse(f.response.body) as JsonRpcMessage) !== undefined)
			.filter((f) => classifyMcpError(v2Error(f.name)) === null)
			.map((f) => f.name)

		expect(unclassified).toEqual([
			'legacy-tools-call-handler-throw',
			'modern-tools-call-handler-throw',
		])
	})
})
