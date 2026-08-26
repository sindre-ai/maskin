import { describe, expect, it } from 'vitest'
import { parseResultLine, scanTurnLine, splitLines } from '../stream-json'

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

describe('scanTurnLine', () => {
	const assistantLine = (content: unknown[], overrides: Record<string, unknown> = {}) =>
		JSON.stringify({
			type: 'assistant',
			message: { id: 'gen-1', role: 'assistant', content },
			...overrides,
		})

	it('returns the joined text blocks of an assistant line', () => {
		const scanned = scanTurnLine(
			assistantLine([
				{ type: 'text', text: 'Here is ' },
				{ type: 'text', text: 'the answer.' },
			]),
		)
		expect(scanned).toEqual({ kind: 'assistant_text', text: 'Here is the answer.' })
	})

	it('ignores non-text blocks alongside the text', () => {
		const scanned = scanTurnLine(
			assistantLine([
				{ type: 'thinking', thinking: 'hmm' },
				{ type: 'text', text: 'Reply.' },
				{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
			]),
		)
		expect(scanned).toEqual({ kind: 'assistant_text', text: 'Reply.' })
	})

	it('treats a thinking-only assistant line as nothing to say', () => {
		expect(scanTurnLine(assistantLine([{ type: 'thinking', thinking: 'hmm' }]))).toEqual({
			kind: 'other',
		})
	})

	it('treats whitespace-only text as nothing to say', () => {
		expect(scanTurnLine(assistantLine([{ type: 'text', text: '  \n ' }]))).toEqual({
			kind: 'other',
		})
	})

	it('rejects sub-agent output so a Task result cannot become the reply', () => {
		expect(
			scanTurnLine(
				assistantLine([{ type: 'text', text: 'sub-agent finding' }], {
					parent_tool_use_id: 'call_parent',
				}),
			),
		).toEqual({ kind: 'other' })
	})

	it('marks a result envelope as the turn boundary', () => {
		expect(scanTurnLine(JSON.stringify({ type: 'result', result: 'done' }))).toEqual({
			kind: 'boundary',
		})
	})

	it('does not treat a sub-agent result as the turn boundary', () => {
		// parseResultLine already rejects these. If the scan stopped here it would
		// abandon recovery mid-turn for any turn that dispatched a Task and then
		// closed on a blank result — the exact turn this scan exists to save.
		expect(
			scanTurnLine(
				JSON.stringify({ type: 'result', result: 'sub done', parent_tool_use_id: 'call_parent' }),
			),
		).toEqual({ kind: 'other' })
	})

	it('marks a tagged user envelope as the turn boundary but not a tool_result', () => {
		expect(
			scanTurnLine(JSON.stringify({ type: 'user', maskin_message_id: 42, message: {} })),
		).toEqual({ kind: 'boundary' })
		expect(
			scanTurnLine(
				JSON.stringify({
					type: 'user',
					message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
				}),
			),
		).toEqual({ kind: 'other' })
	})

	it('returns other for malformed or non-JSON lines', () => {
		expect(scanTurnLine('not json')).toEqual({ kind: 'other' })
		expect(scanTurnLine('{oops')).toEqual({ kind: 'other' })
		expect(scanTurnLine('')).toEqual({ kind: 'other' })
	})
})
