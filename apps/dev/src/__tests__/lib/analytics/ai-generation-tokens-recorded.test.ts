import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { LLM_ROUTE_OAUTH } from '../../../lib/llm-routing'

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
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0.42,
		activeMs: 600_000,
		startedAt: new Date('2026-11-04T10:00:00Z'),
		completedAt: new Date('2026-11-04T10:30:00Z'),
		...overrides,
	}
}

function lastProps(): Record<string, unknown> {
	const call = capturePosthogEventMock.mock.calls.at(-1)
	if (!call) throw new Error('capturePosthogEvent was not called')
	return call[2] as Record<string, unknown>
}

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('trackSessionAiGeneration tokens_recorded', () => {
	it('is true when the session saved output tokens', async () => {
		await trackSessionAiGeneration(baseProps())

		expect(lastProps().tokens_recorded).toBe(true)
	})

	it.each([null, 0])(
		'is false for a session that failed before any model call (output tokens %s)',
		async (outputTokens) => {
			await trackSessionAiGeneration(
				baseProps({
					outcome: 'failed',
					failureReasonCode: 'session_limit',
					inputTokens: null,
					outputTokens,
					costUsd: null,
				}),
			)

			const props = lastProps()
			expect(props.tokens_recorded).toBe(false)
			expect(props.$ai_total_cost_usd).toBe(0)
		},
	)
})
