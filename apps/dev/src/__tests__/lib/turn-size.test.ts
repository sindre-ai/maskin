import { describe, expect, it } from 'vitest'
import {
	ROTATION_MAX_TOKENS,
	TurnSizeObserver,
	classifyContextFailure,
	rotationLineTokens,
	sizeBucket,
} from '../../lib/turn-size'

const assistantLine = (
	usage: { input: number; creation?: number; read?: number },
	extra: Record<string, unknown> = {},
) =>
	`${JSON.stringify({
		type: 'assistant',
		message: {
			id: `msg-${usage.input}`,
			usage: {
				input_tokens: usage.input,
				cache_creation_input_tokens: usage.creation ?? 0,
				cache_read_input_tokens: usage.read ?? 0,
				output_tokens: 10,
			},
		},
		...extra,
	})}\n`

const resultLine = (
	overrides: Record<string, unknown> = {},
	modelUsage: Record<string, unknown> = { 'deepseek/x': { contextWindow: 1_000_000 } },
) =>
	`${JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'done',
		// The result usage sums every model call of the turn, so it reads far too big.
		usage: { input_tokens: 900_000, cache_read_input_tokens: 0 },
		modelUsage,
		...overrides,
	})}\n`

describe('TurnSizeObserver', () => {
	it('reads the last top-level model call, not the turn sum', () => {
		const observer = new TurnSizeObserver()
		const readings = observer.feed(
			assistantLine({ input: 10_000, read: 40_000 }) +
				assistantLine({ input: 12_000, creation: 3_000, read: 60_000 }) +
				resultLine(),
		)
		expect(readings).toHaveLength(1)
		expect(readings[0]?.lastTurnWindowTokens).toBe(75_000)
		expect(readings[0]?.contextWindowTokens).toBe(1_000_000)
	})

	it('treats zero usage as no reading, as on the 16 Oct DeepSeek runs', () => {
		const observer = new TurnSizeObserver()
		const zero = `${JSON.stringify({
			type: 'assistant',
			message: {
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: null,
					cache_read_input_tokens: null,
				},
			},
		})}\n`
		const readings = observer.feed(zero + zero + resultLine())
		expect(readings[0]?.lastTurnWindowTokens).toBeNull()
		// A zero line never wipes a real reading from an earlier call of the same turn.
		const mixed = new TurnSizeObserver().feed(
			assistantLine({ input: 10_000, read: 50_000 }) + zero + resultLine(),
		)
		expect(mixed[0]?.lastTurnWindowTokens).toBe(60_000)
	})

	it('reads the failure codes off the result line', () => {
		const observer = new TurnSizeObserver()
		const [reading] = observer.feed(
			resultLine({
				is_error: true,
				api_error: 'autocompact_thrashing',
				terminal_reason: 'rapid_refill_breaker',
			}),
		)
		expect(reading?.apiError).toBe('autocompact_thrashing')
		expect(reading?.terminalReason).toBe('rapid_refill_breaker')
		const [clean] = new TurnSizeObserver().feed(resultLine())
		expect(clean?.apiError).toBeNull()
		expect(clean?.terminalReason).toBeNull()
	})

	it('ignores sub-agent assistant lines', () => {
		const observer = new TurnSizeObserver()
		const readings = observer.feed(
			assistantLine({ input: 20_000 }) +
				assistantLine({ input: 150_000 }, { parent_tool_use_id: 'toolu_1' }) +
				resultLine(),
		)
		expect(readings[0]?.lastTurnWindowTokens).toBe(20_000)
	})

	it('carries a line split across chunks', () => {
		const observer = new TurnSizeObserver()
		const whole = assistantLine({ input: 33_000 }) + resultLine()
		const cut = Math.floor(whole.length / 2)
		expect(observer.feed(whole.slice(0, cut))).toEqual([])
		const readings = observer.feed(whole.slice(cut))
		expect(readings[0]?.lastTurnWindowTokens).toBe(33_000)
	})

	it('starts each turn from nothing and reports one reading per result', () => {
		const observer = new TurnSizeObserver()
		const readings = observer.feed(
			assistantLine({ input: 50_000 }) + resultLine() + resultLine({ result: 'again' }),
		)
		expect(readings.map((r) => r.lastTurnWindowTokens)).toEqual([50_000, null])
	})

	it('takes the largest window of the models the session reports', () => {
		const observer = new TurnSizeObserver()
		const readings = observer.feed(
			resultLine({}, { a: { contextWindow: 200_000 }, b: { contextWindow: 1_000_000 } }),
		)
		expect(readings[0]?.contextWindowTokens).toBe(1_000_000)
	})

	it('leaves the window empty when the result reports none', () => {
		const observer = new TurnSizeObserver()
		const readings = observer.feed(resultLine({}, {}))
		expect(readings[0]?.contextWindowTokens).toBeNull()
	})

	it('counts compactions and forgets the size from before one', () => {
		const observer = new TurnSizeObserver()
		const boundary = `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`
		const readings = observer.feed(
			assistantLine({ input: 190_000 }) + boundary + boundary + resultLine(),
		)
		expect(readings[0]?.compactionsInTurn).toBe(2)
		expect(readings[0]?.lastTurnWindowTokens).toBeNull()
	})

	it('exposes the compactions so far for a session with no turns', () => {
		const observer = new TurnSizeObserver()
		const boundary = `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`
		observer.feed(boundary + boundary + boundary)
		expect(observer.pendingCompactions).toBe(3)
	})
})

describe('rotationLineTokens', () => {
	it('gives a 1M window the 150k cap', () => {
		expect(rotationLineTokens(1_000_000)).toBe(ROTATION_MAX_TOKENS)
	})

	it('gives a 200k window 120k', () => {
		expect(rotationLineTokens(200_000)).toBe(120_000)
	})

	it('falls back to what Maskin knows for the model, then to 200k', () => {
		expect(rotationLineTokens(null, 'deepseek/deepseek-v4.1-flash')).toBe(ROTATION_MAX_TOKENS)
		expect(rotationLineTokens(null, 'claude-sonnet-5-5')).toBe(120_000)
		expect(rotationLineTokens(null, null)).toBe(120_000)
	})
})

describe('sizeBucket', () => {
	it.each([
		[null, 'unknown'],
		[50_000, 'lt_100k'],
		[120_000, '100k_150k'],
		[160_000, '150k_200k'],
		[300_000, '200k_400k'],
		[500_000, 'gte_400k'],
	] as const)('%s tokens is %s', (tokens, bucket) => {
		expect(sizeBucket(tokens)).toBe(bucket)
	})
})

describe('classifyContextFailure', () => {
	const turn = (text: string, isError = true, compactionsInTurn = 0) => ({
		text,
		isError,
		compactionsInTurn,
	})

	it('reads a failed compaction from the error text', () => {
		expect(classifyContextFailure(turn('Error: Compaction failed: empty summary'))).toBe(
			'compaction_failed',
		)
		expect(classifyContextFailure(turn('autocompact returned an empty summarisation'))).toBe(
			'compaction_failed',
		)
	})

	it('reads the thrashing text and codes from the 16 Oct DeepSeek failure', () => {
		const text =
			'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.'
		expect(classifyContextFailure(turn(text))).toBe('compaction_failed')
		// The codes decide even when the wording changes.
		expect(
			classifyContextFailure({ ...turn('Something else'), apiError: 'autocompact_thrashing' }),
		).toBe('compaction_failed')
		expect(
			classifyContextFailure({ ...turn('Something else'), terminalReason: 'rapid_refill_breaker' }),
		).toBe('compaction_failed')
		expect(
			classifyContextFailure(
				turn('automatic compaction failed: summarization produced empty response'),
			),
		).toBe('compaction_failed')
	})

	it('reads a full window from the error text', () => {
		expect(classifyContextFailure(turn('Prompt is too long'))).toBe('context_full')
		expect(
			classifyContextFailure(turn('maximum context length is 1048576 tokens, you sent more')),
		).toBe('context_full')
	})

	it('treats two compactions in one turn as a loop, error or not', () => {
		expect(classifyContextFailure(turn('all good', false, 2))).toBe('compaction_failed')
	})

	it('is null for a clean turn and for an unrelated error', () => {
		expect(classifyContextFailure(turn('Here is your answer', false))).toBeNull()
		expect(classifyContextFailure(turn('API Error: 500 overloaded'))).toBeNull()
		expect(classifyContextFailure(turn('one compaction happened', false, 1))).toBeNull()
	})
})
