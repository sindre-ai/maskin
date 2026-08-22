import { describe, expect, it } from 'vitest'
import { parseResultLine, splitLines } from '../stream-json'

const resultLine = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'Here is the answer.',
		duration_ms: 1234,
		total_cost_usd: 0.42,
		usage: {
			input_tokens: 10,
			output_tokens: 20,
			cache_creation_input_tokens: 30,
			cache_read_input_tokens: 40,
		},
		...extra,
	})

describe('splitLines', () => {
	it('returns complete lines and an empty remainder when text ends with a newline', () => {
		expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], remainder: '' })
	})

	it('holds a trailing partial line back as the remainder', () => {
		expect(splitLines('a\nb')).toEqual({ lines: ['a'], remainder: 'b' })
	})

	it('treats text with no newline as entirely remainder', () => {
		expect(splitLines('{"type":"res')).toEqual({ lines: [], remainder: '{"type":"res' })
	})

	it('reassembles a line split across two chunks', () => {
		const first = splitLines('{"type":"resu')
		const second = splitLines(`${first.remainder}lt"}\n`)
		expect(second.lines).toEqual(['{"type":"result"}'])
	})
})

describe('parseResultLine', () => {
	it('parses a result envelope with text, flags and usage', () => {
		const parsed = parseResultLine(resultLine())
		expect(parsed).not.toBeNull()
		expect(parsed?.text).toBe('Here is the answer.')
		expect(parsed?.isError).toBe(false)
		expect(parsed?.subtype).toBe('success')
		expect(parsed?.usage).toEqual({
			totalCostUsd: 0.42,
			inputTokens: 10,
			outputTokens: 20,
			cacheCreationInputTokens: 30,
			cacheReadInputTokens: 40,
			durationMs: 1234,
		})
	})

	it('returns the trimmed line as raw so the dedupe hash is stable', () => {
		const line = resultLine()
		expect(parseResultLine(`  ${line}  `)?.raw).toBe(line)
	})

	it('rejects sub-agent results carrying parent_tool_use_id', () => {
		expect(parseResultLine(resultLine({ parent_tool_use_id: 'toolu_123' }))).toBeNull()
	})

	it('returns null for non-result envelopes', () => {
		expect(parseResultLine(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull()
	})

	it('returns null for blank lines, non-JSON noise and malformed JSON', () => {
		expect(parseResultLine('')).toBeNull()
		expect(parseResultLine('   ')).toBeNull()
		expect(parseResultLine('npm WARN something')).toBeNull()
		expect(parseResultLine('{"type":"result"')).toBeNull()
	})

	it('returns null for a JSON array or primitive', () => {
		expect(parseResultLine('[1,2,3]')).toBeNull()
		expect(parseResultLine('"result"')).toBeNull()
	})

	it('defaults text to an empty string when result is absent or not a string', () => {
		expect(parseResultLine(JSON.stringify({ type: 'result' }))?.text).toBe('')
		expect(parseResultLine(JSON.stringify({ type: 'result', result: 42 }))?.text).toBe('')
	})

	it('reports error results with their subtype', () => {
		const parsed = parseResultLine(
			resultLine({ is_error: true, subtype: 'error_max_turns', result: 'Ran out of turns.' }),
		)
		expect(parsed?.isError).toBe(true)
		expect(parsed?.subtype).toBe('error_max_turns')
		expect(parsed?.text).toBe('Ran out of turns.')
	})

	it('coerces missing or non-numeric usage fields to null', () => {
		const parsed = parseResultLine(JSON.stringify({ type: 'result', total_cost_usd: 'n/a' }))
		expect(parsed?.usage).toEqual({
			totalCostUsd: null,
			inputTokens: null,
			outputTokens: null,
			cacheCreationInputTokens: null,
			cacheReadInputTokens: null,
			durationMs: null,
		})
	})
})
