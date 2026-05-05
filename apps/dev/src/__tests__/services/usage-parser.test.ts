import { describe, expect, it } from 'vitest'
import { parseUsageFromLogChunks } from '../../services/usage-parser'

const RESULT_SUCCESS = JSON.stringify({
	type: 'result',
	subtype: 'success',
	is_error: false,
	duration_ms: 1823,
	total_cost_usd: 0.00091,
	usage: { input_tokens: 820, output_tokens: 120 },
})

const RESULT_WITH_CACHE = JSON.stringify({
	type: 'result',
	subtype: 'success',
	is_error: false,
	duration_ms: 5000,
	total_cost_usd: 0.0421,
	usage: {
		input_tokens: 100,
		output_tokens: 250,
		cache_creation_input_tokens: 8000,
		cache_read_input_tokens: 16000,
	},
})

describe('parseUsageFromLogChunks', () => {
	it('extracts usage from a clean stream-json result line', () => {
		const result = parseUsageFromLogChunks([`${RESULT_SUCCESS}\n`])
		expect(result).toEqual({
			totalCostUsd: 0.00091,
			inputTokens: 820,
			outputTokens: 120,
			cacheCreationInputTokens: null,
			cacheReadInputTokens: null,
			durationMs: 1823,
		})
	})

	it('captures cache_creation and cache_read tokens when present', () => {
		const result = parseUsageFromLogChunks([`${RESULT_WITH_CACHE}\n`])
		expect(result?.cacheCreationInputTokens).toBe(8000)
		expect(result?.cacheReadInputTokens).toBe(16000)
	})

	it('reassembles a result line split across multiple chunks (multiplex)', () => {
		const half = Math.floor(RESULT_SUCCESS.length / 2)
		const a = RESULT_SUCCESS.slice(0, half)
		const b = `${RESULT_SUCCESS.slice(half)}\n`
		const result = parseUsageFromLogChunks([a, b])
		expect(result?.totalCostUsd).toBe(0.00091)
		expect(result?.inputTokens).toBe(820)
	})

	it('skips earlier non-result events and returns the last result', () => {
		const earlier = JSON.stringify({ type: 'assistant', message: 'thinking...' })
		const result = parseUsageFromLogChunks([`${earlier}\n${RESULT_SUCCESS}\n`])
		expect(result?.outputTokens).toBe(120)
	})

	it('tolerates a trailing truncated/garbled line', () => {
		const garbled = '{"type":"assistant","mes' // never closed
		const result = parseUsageFromLogChunks([`${RESULT_SUCCESS}\n${garbled}`])
		expect(result?.inputTokens).toBe(820)
	})

	it('returns null when no result event is present', () => {
		const noise = '{"type":"assistant","message":"hi"}\n[INFO] starting...\n'
		expect(parseUsageFromLogChunks([noise])).toBeNull()
	})

	it('returns null on plain-text codex / custom output', () => {
		const codex = 'Running task...\nTask completed in 1.4s\n'
		expect(parseUsageFromLogChunks([codex])).toBeNull()
	})

	it('returns null for empty input', () => {
		expect(parseUsageFromLogChunks([])).toBeNull()
		expect(parseUsageFromLogChunks([''])).toBeNull()
	})

	it('coerces missing usage fields to null instead of NaN', () => {
		const minimal = JSON.stringify({
			type: 'result',
			subtype: 'success',
			usage: {},
		})
		const result = parseUsageFromLogChunks([`${minimal}\n`])
		expect(result).toEqual({
			totalCostUsd: null,
			inputTokens: null,
			outputTokens: null,
			cacheCreationInputTokens: null,
			cacheReadInputTokens: null,
			durationMs: null,
		})
	})
})
