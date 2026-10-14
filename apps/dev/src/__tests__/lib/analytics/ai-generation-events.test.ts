import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	type SessionAiGenerationProps,
	trackSessionAiGeneration,
} from '../../../lib/analytics/ai-generation-events'
import {
	CLAUDE_SUBSCRIPTION_MODEL,
	LLM_ROUTE_AGENT,
	LLM_ROUTE_API_KEY,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_MASKIN_PLAN,
	LLM_ROUTE_OAUTH,
} from '../../../lib/llm-routing'

const START = new Date('2026-10-12T10:00:00Z')
const END = new Date('2026-10-12T10:30:00Z')

function baseProps(overrides: Partial<SessionAiGenerationProps> = {}): SessionAiGenerationProps {
	return {
		sessionId: 'sess-1',
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		outcome: 'completed',
		config: { llm_route: LLM_ROUTE_OAUTH },
		modelName: null,
		inputTokens: 1200,
		outputTokens: 300,
		cacheReadTokens: 50_000,
		cacheCreationTokens: 4_000,
		costUsd: 0.42,
		activeMs: 600_000,
		startedAt: START,
		completedAt: END,
		...overrides,
	}
}

function lastCall(): [string, string, Record<string, unknown>] {
	const call = capturePosthogEventMock.mock.calls.at(-1)
	if (!call) throw new Error('capturePosthogEvent was not called')
	return call as [string, string, Record<string, unknown>]
}

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('trackSessionAiGeneration', () => {
	it('emits one $ai_generation keyed on the workspace, with the session as the trace', async () => {
		await trackSessionAiGeneration(baseProps())

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		const [event, distinctId, props] = lastCall()
		expect(event).toBe('$ai_generation')
		expect(distinctId).toBe('ws-1')
		expect(props.$ai_trace_id).toBe('sess-1')
		expect(props.workspace_id).toBe('ws-1')
		expect(props.session_id).toBe('sess-1')
		expect(props.llm_route).toBe(LLM_ROUTE_OAUTH)
	})

	it('carries tokens, cache counts and cost', async () => {
		await trackSessionAiGeneration(baseProps())

		const props = lastCall()[2]
		expect(props.$ai_input_tokens).toBe(1200)
		expect(props.$ai_output_tokens).toBe(300)
		expect(props.$ai_cache_read_input_tokens).toBe(50_000)
		expect(props.$ai_cache_creation_input_tokens).toBe(4_000)
		expect(props.$ai_total_cost_usd).toBe(0.42)
	})

	it('puts wall-clock and active time plus both timestamps on the same event', async () => {
		await trackSessionAiGeneration(baseProps())

		const props = lastCall()[2]
		expect(props.running_seconds).toBe(1800)
		expect(props.active_seconds).toBe(600)
		expect(props.$ai_latency).toBe(1800)
		expect(props.started_at).toBe(START.toISOString())
		expect(props.completed_at).toBe(END.toISOString())
	})

	it('leaves active_seconds null when the CLI reported no duration', async () => {
		await trackSessionAiGeneration(baseProps({ activeMs: null }))

		expect(lastCall()[2].active_seconds).toBeNull()
	})

	it('never sends prompt or completion text', async () => {
		await trackSessionAiGeneration(baseProps())

		const props = lastCall()[2]
		expect(props).not.toHaveProperty('$ai_input')
		expect(props).not.toHaveProperty('$ai_output_choices')
	})

	it('falls back to the subscription model on claude_oauth, where model_name is null', async () => {
		await trackSessionAiGeneration(baseProps())

		const props = lastCall()[2]
		expect(props.$ai_model).toBe(CLAUDE_SUBSCRIPTION_MODEL)
		expect(props.$ai_provider).toBe('anthropic')
		expect(props.cost_basis).toBe('cli_list_price')
	})

	it('uses the stored model, openrouter provider and price-table basis on maskin_plan', async () => {
		await trackSessionAiGeneration(
			baseProps({
				config: { llm_route: LLM_ROUTE_MASKIN_PLAN },
				modelName: 'deepseek/deepseek-v4.1-flash',
			}),
		)

		const props = lastCall()[2]
		expect(props.$ai_model).toBe('deepseek/deepseek-v4.1-flash')
		expect(props.$ai_provider).toBe('openrouter')
		expect(props.cost_basis).toBe('openrouter_price_table')
	})

	it.each([LLM_ROUTE_API_KEY, LLM_ROUTE_AGENT, LLM_ROUTE_CUSTOM])(
		'labels the model unknown:<route> on %s, which has no default model',
		async (route) => {
			await trackSessionAiGeneration(baseProps({ config: { llm_route: route } }))

			expect(lastCall()[2].$ai_model).toBe(`unknown:${route}`)
		},
	)

	it('prefers the stored model over the unknown:<route> label', async () => {
		await trackSessionAiGeneration(
			baseProps({ config: { llm_route: LLM_ROUTE_API_KEY }, modelName: 'claude-sonnet-5-5' }),
		)

		expect(lastCall()[2].$ai_model).toBe('claude-sonnet-5-5')
	})

	it('reads the numeric-string cost Drizzle returns for total_cost_usd', async () => {
		await trackSessionAiGeneration(baseProps({ costUsd: '1.2345' }))

		expect(lastCall()[2].$ai_total_cost_usd).toBe(1.2345)
	})

	it('sends 0 rather than NaN when cost is missing or unparseable', async () => {
		await trackSessionAiGeneration(baseProps({ costUsd: null }))
		expect(lastCall()[2].$ai_total_cost_usd).toBe(0)

		await trackSessionAiGeneration(baseProps({ costUsd: 'not-a-number' }))
		expect(lastCall()[2].$ai_total_cost_usd).toBe(0)
	})

	it('marks failed and timeout sessions as errors, completed and user_stopped as not', async () => {
		for (const [outcome, isError] of [
			['failed', true],
			['timeout', true],
			['completed', false],
			['user_stopped', false],
		] as const) {
			await trackSessionAiGeneration(baseProps({ outcome }))
			const props = lastCall()[2]
			expect(props.outcome).toBe(outcome)
			expect(props.$ai_is_error).toBe(isError)
		}
	})

	it('skips sessions that never launched (no started_at)', async () => {
		await trackSessionAiGeneration(baseProps({ startedAt: null }))

		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('tolerates a missing config', async () => {
		await trackSessionAiGeneration(baseProps({ config: null }))

		const props = lastCall()[2]
		expect(props.llm_route).toBeNull()
		expect(props.$ai_model).toBe('unknown')
		expect(props.$ai_provider).toBe('unknown')
	})

	it('never throws when the capture rejects', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))

		await expect(trackSessionAiGeneration(baseProps())).resolves.toBeUndefined()
	})
})
