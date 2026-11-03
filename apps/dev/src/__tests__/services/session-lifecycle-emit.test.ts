import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { LLM_ROUTE_MASKIN_PLAN, LLM_ROUTE_OAUTH } from '../../lib/llm-routing'
import {
	type EmitCompletionUsageTotals,
	type SettleOutcome,
	emitCompletion,
	isPlanRouteSession,
	mapKindToOutcomeProp,
} from '../../services/session-lifecycle'

const START = new Date('2026-09-29T10:00:00Z')
const END = new Date('2026-09-29T10:05:00Z')
const EXPECTED_DURATION_MS = END.getTime() - START.getTime()

function baseSession(overrides: Partial<Parameters<typeof emitCompletion>[0]> = {}) {
	return {
		id: 'sess-1',
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		agentServerId: null,
		config: {},
		triggerId: null,
		startedAt: START,
		...overrides,
	}
}

function baseOutcome(overrides: Partial<SettleOutcome> = {}): SettleOutcome {
	return {
		kind: 'complete',
		classification: 'agent_completed',
		source: 'sandbox-exit',
		...overrides,
	}
}

const ZERO_TOTALS: EmitCompletionUsageTotals = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	costUsd: null,
}

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('mapKindToOutcomeProp', () => {
	it('covers every TerminalOutcomeKind with the §9.2 unified enum', () => {
		expect(mapKindToOutcomeProp('complete')).toBe('completed')
		expect(mapKindToOutcomeProp('fail')).toBe('failed')
		expect(mapKindToOutcomeProp('timeout')).toBe('timeout')
		expect(mapKindToOutcomeProp('stop')).toBe('user_stopped')
		expect(mapKindToOutcomeProp('pause')).toBe('paused')
	})
})

describe('isPlanRouteSession — verbatim to Task 1 S3 predicate', () => {
	it('is true when config.llm_route is LLM_ROUTE_MASKIN_PLAN', () => {
		expect(isPlanRouteSession({ config: { llm_route: LLM_ROUTE_MASKIN_PLAN } })).toBe(true)
	})

	it('is false for the OAuth route', () => {
		expect(isPlanRouteSession({ config: { llm_route: LLM_ROUTE_OAUTH } })).toBe(false)
	})

	it('is false when config is null or has no llm_route', () => {
		expect(isPlanRouteSession({ config: null })).toBe(false)
		expect(isPlanRouteSession({ config: {} })).toBe(false)
		expect(isPlanRouteSession({ config: { other: 'thing' } })).toBe(false)
	})
})

describe('emitCompletion — agent_session_completed', () => {
	it('fires with host = "local" when agentServerId is null (100% coverage of §9.2 host prop)', async () => {
		await emitCompletion(baseSession(), baseOutcome(), ZERO_TOTALS, END)

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_completed',
			'ws-1',
			expect.objectContaining({ host: 'local' }),
		)
	})

	it('fires with host = "remote" when agentServerId is set', async () => {
		await emitCompletion(baseSession({ agentServerId: 'srv-1' }), baseOutcome(), ZERO_TOTALS, END)

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_completed',
			'ws-1',
			expect.objectContaining({ host: 'remote' }),
		)
	})

	it('populates outcome, duration_ms, and classification per §9.2', async () => {
		await emitCompletion(
			baseSession(),
			baseOutcome({ kind: 'timeout', classification: 'wall_timeout' }),
			ZERO_TOTALS,
			END,
		)

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_completed',
			'ws-1',
			expect.objectContaining({
				outcome: 'timeout',
				classification: 'wall_timeout',
				duration_ms: EXPECTED_DURATION_MS,
			}),
		)
	})

	it('carries every §9.2 prop and uses workspaceId as distinct_id', async () => {
		await emitCompletion(
			baseSession({
				agentServerId: 'srv-9',
				triggerId: 'trig-42',
				config: {
					llm_route: LLM_ROUTE_OAUTH,
					trigger_source: 'cron',
					skill_staging: { manifest_skills: 3, staged: 2 },
				},
			}),
			baseOutcome({
				kind: 'fail',
				classification: 'credit_exhaustion',
				reason: 'plan cap hit',
				exitCode: 137,
				usage: {
					inputTokens: 1000,
					outputTokens: 200,
					cacheReadTokens: 50,
					cacheCreationTokens: 25,
					costUsd: 0.12,
				},
			}),
			{
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 50,
				cacheCreationTokens: 25,
				costUsd: 0.12,
			},
			END,
		)

		expect(capturePosthogEventMock).toHaveBeenCalledWith('agent_session_completed', 'ws-1', {
			session_id: 'sess-1',
			actor_id: 'actor-1',
			workspace_id: 'ws-1',
			trigger_id: 'trig-42',
			trigger_source: 'cron',
			host: 'remote',
			outcome: 'failed',
			classification: 'credit_exhaustion',
			stop_reason: 'plan cap hit',
			exit_code: 137,
			duration_ms: EXPECTED_DURATION_MS,
			input_tokens: 1000,
			output_tokens: 200,
			cache_read_tokens: 50,
			cache_creation_tokens: 25,
			cost_usd: 0.12,
			skills_attached: 3,
			skills_staged: 2,
		})
	})

	it('falls back to duration_ms = 0 when startedAt is null', async () => {
		await emitCompletion(baseSession({ startedAt: null }), baseOutcome(), ZERO_TOTALS, END)

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_completed',
			'ws-1',
			expect.objectContaining({ duration_ms: 0 }),
		)
	})

	it('emits null for skills_attached / skills_staged when config carries no staging block', async () => {
		await emitCompletion(baseSession({ config: null }), baseOutcome(), ZERO_TOTALS, END)

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_completed',
			'ws-1',
			expect.objectContaining({
				skills_attached: null,
				skills_staged: null,
				trigger_source: null,
			}),
		)
	})

	it('swallows a capture rejection instead of throwing into settleSession', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))
		await expect(emitCompletion(baseSession(), baseOutcome(), ZERO_TOTALS, END)).resolves.toBe(true)
	})
})

describe('emitCompletion — maskin_plan_session_completed dual-emit', () => {
	it('fires on plan-route sessions with usage, shape matches pre-commit baseline', async () => {
		await emitCompletion(
			baseSession({ config: { llm_route: LLM_ROUTE_MASKIN_PLAN } }),
			baseOutcome({
				kind: 'complete',
				usage: { inputTokens: 500, outputTokens: 150, costUsd: 0.05 },
			}),
			{
				inputTokens: 500,
				outputTokens: 150,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0.05,
			},
			END,
		)

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(2)
		expect(capturePosthogEventMock).toHaveBeenNthCalledWith(
			2,
			'maskin_plan_session_completed',
			'ws-1',
			{
				actor_id: 'actor-1',
				session_id: 'sess-1',
				input_tokens: 500,
				output_tokens: 150,
				total_cost_usd: 0.05,
				duration_ms: EXPECTED_DURATION_MS,
				status: 'completed',
			},
		)
	})

	it('does NOT fire on non-plan-route sessions even when usage is present', async () => {
		await emitCompletion(
			baseSession({ config: { llm_route: LLM_ROUTE_OAUTH } }),
			baseOutcome({ usage: { inputTokens: 100, outputTokens: 50 } }),
			{
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: null,
			},
			END,
		)

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_completed',
			'ws-1',
			expect.any(Object),
		)
	})

	it('does NOT fire on plan-route sessions when the settle carries no usage', async () => {
		await emitCompletion(
			baseSession({ config: { llm_route: LLM_ROUTE_MASKIN_PLAN } }),
			baseOutcome({ kind: 'timeout', classification: 'wall_timeout' }),
			ZERO_TOTALS,
			END,
		)

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_completed',
			'ws-1',
			expect.any(Object),
		)
	})
})
