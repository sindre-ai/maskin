import { describe, expect, it } from 'vitest'
import { FirstCallObserver, parseStartPromptSizeLine } from '../../../lib/analytics/first-call-size'

const init = (tools: string[]) =>
	`${JSON.stringify({ type: 'system', subtype: 'init', tools, mcp_servers: [] })}\n`

const assistant = (
	id: string,
	usage: Record<string, number>,
	extra: Record<string, unknown> = {},
) => `${JSON.stringify({ type: 'assistant', message: { id, usage }, ...extra })}\n`

const result = (usage: Record<string, number>, cost: number, extra: Record<string, unknown> = {}) =>
	`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: cost, usage, ...extra })}\n`

describe('FirstCallObserver', () => {
	it('adds input, cache creation and cache read tokens of the first call', () => {
		const observer = new FirstCallObserver()
		expect(observer.feed(init(['a', 'b', 'c']))).toBeNull()
		expect(
			observer.feed(
				assistant('m1', {
					input_tokens: 4,
					cache_creation_input_tokens: 1_000,
					cache_read_input_tokens: 58_000,
					output_tokens: 9,
				}),
			),
		).toBeNull()
		const first = observer.feed(result({ input_tokens: 4, output_tokens: 9 }, 0.12))
		expect(first?.size).toEqual({
			toolCount: 3,
			firstCallInputTokens: 59_004,
			firstTurnCostUsd: 0.12,
			cacheHit: true,
		})
	})

	it('counts the first call, not the later calls of the same turn', () => {
		const observer = new FirstCallObserver()
		observer.feed(init(['a']))
		observer.feed(assistant('m1', { input_tokens: 10, cache_read_input_tokens: 100 }))
		observer.feed(assistant('m2', { input_tokens: 20, cache_read_input_tokens: 5_000 }))
		const first = observer.feed(result({ input_tokens: 30, cache_read_input_tokens: 5_100 }, 1))
		expect(first?.size.firstCallInputTokens).toBe(110)
	})

	it('reports cache_hit false when nothing was read from the cache', () => {
		const observer = new FirstCallObserver()
		observer.feed(assistant('m1', { input_tokens: 300_000, cache_read_input_tokens: 0 }))
		const first = observer.feed(result({ input_tokens: 300_000 }, 1.13))
		expect(first?.size.cacheHit).toBe(false)
		expect(first?.size.firstCallInputTokens).toBe(300_000)
	})

	it('ignores sub-agent messages and results', () => {
		const observer = new FirstCallObserver()
		observer.feed(assistant('sub', { input_tokens: 1 }, { parent_tool_use_id: 'toolu_1' }))
		expect(
			observer.feed(result({ input_tokens: 1 }, 0.5, { parent_tool_use_id: 'toolu_1' })),
		).toBeNull()
		observer.feed(assistant('m1', { input_tokens: 7 }))
		const first = observer.feed(result({ input_tokens: 7 }, 0.2))
		expect(first?.size.firstCallInputTokens).toBe(7)
	})

	it('reads a line split across chunks', () => {
		const observer = new FirstCallObserver()
		const line = init(['a', 'b'])
		expect(observer.feed(line.slice(0, 20))).toBeNull()
		expect(observer.feed(line.slice(20))).toBeNull()
		const first = observer.feed(result({ input_tokens: 1 }, 0))
		expect(first?.size.toolCount).toBe(2)
	})

	it('leaves fields null that the stream never showed', () => {
		const observer = new FirstCallObserver()
		const first = observer.feed(result({ input_tokens: 5 }, 0.01))
		expect(first?.size).toEqual({
			toolCount: null,
			firstCallInputTokens: null,
			firstTurnCostUsd: 0.01,
			cacheHit: null,
		})
	})

	it('finishes once and ignores everything after, replays included', () => {
		const observer = new FirstCallObserver()
		observer.feed(assistant('m1', { input_tokens: 1 }))
		expect(observer.feed(result({ input_tokens: 1 }, 0.1))).not.toBeNull()
		expect(observer.done).toBe(true)
		expect(observer.feed(result({ input_tokens: 1 }, 0.2))).toBeNull()
	})

	it('hands back the result usage so the turn can be priced for its route', () => {
		const observer = new FirstCallObserver()
		const first = observer.feed(
			result(
				{
					input_tokens: 2,
					output_tokens: 3,
					cache_creation_input_tokens: 4,
					cache_read_input_tokens: 5,
				},
				0.3,
			),
		)
		expect(first?.resultUsage).toEqual({
			inputTokens: 2,
			outputTokens: 3,
			cacheCreationInputTokens: 4,
			cacheReadInputTokens: 5,
			totalCostUsd: 0.3,
		})
	})

	it('reads the start prompt size line before the first turn, and only the first one', () => {
		const line = (learnings: number, capped: boolean) =>
			`[system] start prompt size: persona_bytes=900 total_bytes=25000 learnings_bytes=${learnings} learnings_capped=${capped}\n`
		const observer = new FirstCallObserver()
		expect(observer.startPromptSize).toBeNull()
		observer.feed(line(20_291, true))
		observer.feed(line(5, false))
		expect(observer.startPromptSize).toEqual({
			personaBytes: 900,
			totalBytes: 25_000,
			learningsBytes: 20_291,
			learningsCapped: true,
		})
		const first = observer.feed(result({ input_tokens: 1 }, 0.1))
		expect(first).not.toBeNull()
	})
})

describe('parseStartPromptSizeLine', () => {
	it('returns null for a line that is not the size line or is malformed', () => {
		expect(parseStartPromptSizeLine('[system] Context file written to x')).toBeNull()
		expect(
			parseStartPromptSizeLine('[system] start prompt size: persona_bytes=x total_bytes=1'),
		).toBeNull()
	})
})
