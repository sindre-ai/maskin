import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getModelPricingMock } = vi.hoisted(() => ({ getModelPricingMock: vi.fn() }))

vi.mock('../../lib/openrouter-pricing', () => ({ getModelPricing: getModelPricingMock }))

import {
	addTurnUsage,
	parseAssistantUsageFromLogChunks,
	parseUsageFromLogChunks,
	resolveSessionCostUsd,
} from '../../services/usage-parser'
import type { SessionUsage } from '../../services/usage-parser'

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

const assistantLine = (id: string, usage: Record<string, number>) =>
	JSON.stringify({ type: 'assistant', message: { id, usage } })

describe('parseAssistantUsageFromLogChunks', () => {
	it('sums assistant usage with cost and duration left null', () => {
		const chunk = `${assistantLine('msg_1', { input_tokens: 10, output_tokens: 5 })}\n${assistantLine('msg_2', { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 100 })}\n`
		expect(parseAssistantUsageFromLogChunks([chunk])).toEqual({
			totalCostUsd: null,
			inputTokens: 30,
			outputTokens: 12,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 100,
			durationMs: null,
		})
	})

	it('counts a message id once when its usage repeats across content-block lines', () => {
		const chunk = `${assistantLine('msg_1', { input_tokens: 10, output_tokens: 2 })}\n${assistantLine('msg_1', { input_tokens: 10, output_tokens: 9 })}\n`
		const result = parseAssistantUsageFromLogChunks([chunk])
		expect(result?.inputTokens).toBe(10)
		expect(result?.outputTokens).toBe(9)
	})

	it('restarts counting after the last result envelope', () => {
		const chunk = `${assistantLine('msg_1', { input_tokens: 500, output_tokens: 500 })}\n${RESULT_SUCCESS}\n${assistantLine('msg_2', { input_tokens: 3, output_tokens: 4 })}\n`
		const result = parseAssistantUsageFromLogChunks([chunk])
		expect(result?.inputTokens).toBe(3)
		expect(result?.outputTokens).toBe(4)
	})

	it('ignores sub-agent assistant lines and lines without a message id', () => {
		const subAgent = JSON.stringify({
			type: 'assistant',
			parent_tool_use_id: 'toolu_1',
			message: { id: 'msg_sub', usage: { input_tokens: 99, output_tokens: 99 } },
		})
		const noId = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } })
		expect(parseAssistantUsageFromLogChunks([`${subAgent}\n${noId}\n`])).toBeNull()
	})

	it('returns null when the log has no assistant usage', () => {
		expect(parseAssistantUsageFromLogChunks([])).toBeNull()
		expect(parseAssistantUsageFromLogChunks(['[INFO] starting...\n'])).toBeNull()
	})
})

const DEEPSEEK_PRICING = {
	prompt: 0.00000007,
	completion: 0.00000014,
	cacheRead: 0.000000014,
	cacheWrite: 0,
}

const usage = (overrides: Partial<SessionUsage> = {}): SessionUsage => ({
	totalCostUsd: 0.42,
	inputTokens: null,
	outputTokens: null,
	cacheCreationInputTokens: null,
	cacheReadInputTokens: null,
	durationMs: null,
	...overrides,
})

describe('resolveSessionCostUsd', () => {
	beforeEach(() => {
		getModelPricingMock.mockReset()
	})

	it('passes the CLI-reported cost through untouched on the claude_oauth route', async () => {
		const resolved = await resolveSessionCostUsd({
			route: 'claude_oauth',
			modelName: null,
			usage: usage({ totalCostUsd: 0.42, inputTokens: 1000, outputTokens: 500 }),
		})
		expect(resolved).toBe(0.42)
		expect(getModelPricingMock).not.toHaveBeenCalled()
	})

	it('prices a maskin_plan session from tokens at the model per-token rates', async () => {
		getModelPricingMock.mockResolvedValue(DEEPSEEK_PRICING)
		const resolved = await resolveSessionCostUsd({
			route: 'maskin_plan',
			modelName: 'deepseek/deepseek-v4-flash',
			usage: usage({
				totalCostUsd: 0.42,
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 10000,
			}),
		})
		// 1000*7e-8 + 500*1.4e-7 + 10000*1.4e-8 = 0.00028, ignoring the CLI figure.
		expect(resolved).toBeCloseTo(0.00028, 12)
		expect(getModelPricingMock).toHaveBeenCalledWith('deepseek/deepseek-v4-flash')
	})

	it('prices a workspace_custom session from the table, and keeps the CLI figure when the model is unlisted', async () => {
		getModelPricingMock.mockResolvedValueOnce(DEEPSEEK_PRICING)
		const priced = await resolveSessionCostUsd({
			route: 'workspace_custom',
			modelName: 'deepseek/deepseek-v4.1-flash',
			usage: usage({ totalCostUsd: 1.91, inputTokens: 1000, outputTokens: 500 }),
		})
		// 1000*7e-8 + 500*1.4e-7 = 0.00014, ignoring the CLI's $1.91.
		expect(priced).toBeCloseTo(0.00014, 12)
		expect(getModelPricingMock).toHaveBeenCalledWith('deepseek/deepseek-v4.1-flash')

		getModelPricingMock.mockResolvedValueOnce(null)
		const unlisted = await resolveSessionCostUsd({
			route: 'workspace_custom',
			modelName: 'my-company/private-model',
			usage: usage({ totalCostUsd: 0.5, inputTokens: 1000, outputTokens: 500 }),
		})
		expect(unlisted).toBe(0.5)
	})

	it('falls back to the legacy token rate on input+output when the model is unknown', async () => {
		getModelPricingMock.mockResolvedValue(null)
		const resolved = await resolveSessionCostUsd({
			route: 'maskin_plan',
			modelName: 'absent/model',
			usage: usage({ inputTokens: 1000, outputTokens: 500 }),
		})
		// 1500 tokens / 200_000 tokens-per-cent / 100 = 0.000075.
		expect(resolved).toBeCloseTo(0.000075, 12)
	})

	it('falls back to the legacy token rate when no model name was recorded', async () => {
		const resolved = await resolveSessionCostUsd({
			route: 'maskin_plan',
			modelName: null,
			usage: usage({ inputTokens: 1000, outputTokens: 500 }),
		})
		expect(resolved).toBeCloseTo(0.000075, 12)
		expect(getModelPricingMock).not.toHaveBeenCalled()
	})

	it('bills cache-only usage rather than returning free when the model is unknown', async () => {
		getModelPricingMock.mockResolvedValue(null)
		const resolved = await resolveSessionCostUsd({
			route: 'maskin_plan',
			modelName: 'absent/model',
			usage: usage({ cacheReadInputTokens: 10000 }),
		})
		// 10000 / 200_000 / 100 = 0.0005.
		expect(resolved).toBeCloseTo(0.0005, 12)
	})

	it('returns null when there are no tokens to price at all', async () => {
		getModelPricingMock.mockResolvedValue(null)
		const resolved = await resolveSessionCostUsd({
			route: 'maskin_plan',
			modelName: 'absent/model',
			usage: usage({ totalCostUsd: null }),
		})
		expect(resolved).toBeNull()
	})
})

describe('addTurnUsage', () => {
	const turn = (overrides: Partial<SessionUsage> = {}): SessionUsage => ({
		totalCostUsd: 0.1,
		inputTokens: 10,
		outputTokens: 100,
		cacheCreationInputTokens: 5,
		cacheReadInputTokens: 1000,
		durationMs: 2000,
		...overrides,
	})

	it('starts from the first turn as it is', () => {
		expect(addTurnUsage(null, turn())).toEqual(turn())
	})

	it('adds token counts and duration but keeps the newest running cost', () => {
		const total = addTurnUsage(turn(), turn({ totalCostUsd: 0.25, outputTokens: 300 }))
		expect(total).toEqual({
			totalCostUsd: 0.25,
			inputTokens: 20,
			outputTokens: 400,
			cacheCreationInputTokens: 10,
			cacheReadInputTokens: 2000,
			durationMs: 4000,
		})
	})

	it('keeps the earlier cost when a turn reports none, and null for fields no turn reported', () => {
		const total = addTurnUsage(
			turn({ cacheReadInputTokens: null }),
			turn({ totalCostUsd: null, cacheReadInputTokens: null }),
		)
		expect(total.totalCostUsd).toBe(0.1)
		expect(total.cacheReadInputTokens).toBeNull()
		expect(total.outputTokens).toBe(200)
	})
})
