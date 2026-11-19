import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	PERSONA_PROMPT_WARN_BYTES,
	START_PROMPT_WARN_BYTES,
	approximatePromptTokens,
	trackAgentSessionCompletedWithSkills,
	trackAgentSessionStartedWithPrompt,
	trackSessionLaunchModel,
} from '../../../lib/analytics/agent-session-events'
import { logger } from '../../../lib/logger'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('approximatePromptTokens', () => {
	it('rounds up chars/4 so short prompts still register as ≥ 1 token', () => {
		expect(approximatePromptTokens('a')).toBe(1)
		expect(approximatePromptTokens('abcd')).toBe(1)
		expect(approximatePromptTokens('abcde')).toBe(2)
	})

	it('returns 0 for the empty prompt', () => {
		expect(approximatePromptTokens('')).toBe(0)
	})

	it('scales linearly with prompt length', () => {
		const prompt = 'x'.repeat(4000)
		expect(approximatePromptTokens(prompt)).toBe(1000)
	})
})

describe('trackAgentSessionStartedWithPrompt', () => {
	it('emits with agent identity and both chars + token estimates', async () => {
		const systemPrompt = 'x'.repeat(1200)
		await trackAgentSessionStartedWithPrompt({
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			agentId: 'agent-1',
			agentName: 'Bug Triage',
			systemPrompt,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_started_with_prompt',
			'agent-1',
			{
				workspace_id: 'ws-1',
				session_id: 'sess-1',
				agent_id: 'agent-1',
				agent_name: 'Bug Triage',
				system_prompt_chars: 1200,
				system_prompt_tokens: 300,
				source_session_id: null,
			},
			{ timestamp: undefined },
		)
	})

	it('carries the first-call size and the launch time when the first turn ran', async () => {
		const launchedAt = new Date('2026-11-19T10:00:00Z')
		await trackAgentSessionStartedWithPrompt({
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			agentId: 'agent-1',
			agentName: 'Bug Triage',
			systemPrompt: 'ok',
			launchedAt,
			firstCall: {
				toolCount: 551,
				firstCallInputTokens: 59_004,
				firstTurnCostUsd: 0.14,
				cacheHit: false,
			},
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_started_with_prompt',
			'agent-1',
			expect.objectContaining({
				tool_count: 551,
				first_call_input_tokens: 59_004,
				first_turn_cost: 0.14,
				cache_hit: false,
			}),
			{ timestamp: launchedAt },
		)
	})

	it('leaves the four first-call properties off when the launch ended before any turn', async () => {
		await trackAgentSessionStartedWithPrompt({
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			agentId: 'agent-1',
			agentName: 'Bug Triage',
			systemPrompt: 'ok',
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.tool_count).toBeUndefined()
		expect(props.first_call_input_tokens).toBeUndefined()
		expect(props.first_turn_cost).toBeUndefined()
		expect(props.cache_hit).toBeUndefined()
	})

	describe('start prompt size', () => {
		const base = {
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			agentId: 'agent-1',
			agentName: 'Rune',
			systemPrompt: 'ok',
		}
		const size = (
			over: Partial<
				NonNullable<Parameters<typeof trackAgentSessionStartedWithPrompt>[0]['startPrompt']>
			>,
		) => ({
			personaBytes: 1_000,
			totalBytes: 5_000,
			learningsBytes: 2_000,
			learningsCapped: false,
			...over,
		})

		it('carries learnings_bytes and learnings_capped as a number and a boolean', async () => {
			const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
			await trackAgentSessionStartedWithPrompt({
				...base,
				startPrompt: size({ learningsBytes: 20_291, learningsCapped: true }),
			})

			const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
			expect(props.learnings_bytes).toBe(20_291)
			expect(props.learnings_capped).toBe(true)
			expect(warn).not.toHaveBeenCalled()
		})

		it('leaves both properties off when the size line was never read', async () => {
			await trackAgentSessionStartedWithPrompt(base)

			const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
			expect(props.learnings_bytes).toBeUndefined()
			expect(props.learnings_capped).toBeUndefined()
		})

		it('warns once, naming the agent and the size, when the persona prompt is over 30 KB', async () => {
			const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
			await trackAgentSessionStartedWithPrompt({
				...base,
				startPrompt: size({ personaBytes: PERSONA_PROMPT_WARN_BYTES + 1 }),
			})

			expect(warn).toHaveBeenCalledOnce()
			expect(warn).toHaveBeenCalledWith(
				'Agent persona prompt is very large',
				expect.objectContaining({ agentName: 'Rune', personaBytes: PERSONA_PROMPT_WARN_BYTES + 1 }),
			)
			expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		})

		it('warns when the whole start prompt is over 100 KB, and not at exactly 100 KB', async () => {
			const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
			await trackAgentSessionStartedWithPrompt({
				...base,
				startPrompt: size({ totalBytes: START_PROMPT_WARN_BYTES }),
			})
			expect(warn).not.toHaveBeenCalled()

			await trackAgentSessionStartedWithPrompt({
				...base,
				startPrompt: size({ totalBytes: START_PROMPT_WARN_BYTES + 1 }),
			})
			expect(warn).toHaveBeenCalledOnce()
			expect(warn).toHaveBeenCalledWith(
				'Agent start prompt is very large',
				expect.objectContaining({ agentName: 'Rune', totalBytes: START_PROMPT_WARN_BYTES + 1 }),
			)
		})
	})

	it('carries source_session_id when the session was spawned by another session', async () => {
		await trackAgentSessionStartedWithPrompt({
			workspaceId: 'ws-1',
			sessionId: 'sess-child',
			agentId: 'agent-2',
			agentName: 'Sentinel',
			systemPrompt: 'ok',
			sourceSessionId: 'sess-parent',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_started_with_prompt',
			'agent-2',
			expect.objectContaining({ source_session_id: 'sess-parent' }),
			{ timestamp: undefined },
		)
	})

	it('handles an empty systemPrompt without emitting NaN or negative counts', async () => {
		await trackAgentSessionStartedWithPrompt({
			workspaceId: 'ws-1',
			sessionId: 'sess-2',
			agentId: 'agent-1',
			agentName: 'Bug Triage',
			systemPrompt: '',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_started_with_prompt',
			'agent-1',
			expect.objectContaining({ system_prompt_chars: 0, system_prompt_tokens: 0 }),
			{ timestamp: undefined },
		)
	})

	it('swallows capture failures so session launch is never blocked', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))

		await expect(
			trackAgentSessionStartedWithPrompt({
				workspaceId: 'ws-1',
				sessionId: 'sess-3',
				agentId: 'agent-1',
				agentName: 'Bug Triage',
				systemPrompt: 'abc',
			}),
		).resolves.toBeUndefined()
	})

	it('forwards trigger_type and trigger_id for a cron-dispatched session', async () => {
		await trackAgentSessionStartedWithPrompt({
			workspaceId: 'ws-1',
			sessionId: 'sess-4',
			agentId: 'agent-1',
			agentName: 'Bug Triage',
			systemPrompt: 'abc',
			triggerType: 'cron',
			triggerId: 'trig-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_started_with_prompt',
			'agent-1',
			expect.objectContaining({ trigger_type: 'cron', trigger_id: 'trig-1' }),
			{ timestamp: undefined },
		)
	})

	it('forwards trigger_type and trigger_id for an event-dispatched session', async () => {
		await trackAgentSessionStartedWithPrompt({
			workspaceId: 'ws-1',
			sessionId: 'sess-5',
			agentId: 'agent-1',
			agentName: 'Bug Triage',
			systemPrompt: 'abc',
			triggerType: 'event',
			triggerId: 'trig-2',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_started_with_prompt',
			'agent-1',
			expect.objectContaining({ trigger_type: 'event', trigger_id: 'trig-2' }),
			{ timestamp: undefined },
		)
	})

	it('leaves trigger provenance absent for a comment-fallback session', async () => {
		await trackAgentSessionStartedWithPrompt({
			workspaceId: 'ws-1',
			sessionId: 'sess-6',
			agentId: 'agent-1',
			agentName: 'Bug Triage',
			systemPrompt: 'abc',
			triggerSource: 'comment_fallback',
			sourceCommentEventId: 42,
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.trigger_source).toBe('comment_fallback')
		expect(props.trigger_type).toBeUndefined()
		expect(props.trigger_id).toBeUndefined()
	})
})

describe('trackSessionLaunchModel', () => {
	const base = {
		workspaceId: 'ws-1',
		sessionId: 'sess-1',
		agentId: 'agent-1',
		model: 'claude-opus-5-5',
		modelSource: 'agent',
		route: 'claude_oauth',
	}

	it('puts model, model_source and route on agent_session_started', async () => {
		await trackSessionLaunchModel(base)

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		expect(capturePosthogEventMock).toHaveBeenCalledWith('agent_session_started', 'agent-1', {
			workspace_id: 'ws-1',
			session_id: 'sess-1',
			agent_id: 'agent-1',
			model: 'claude-opus-5-5',
			model_source: 'agent',
			route: 'claude_oauth',
			emitted_from: 'dev_backend',
		})
	})

	it('also fires trigger_fired, with the same three properties, for a trigger-dispatched session', async () => {
		await trackSessionLaunchModel({ ...base, triggerId: 'trig-1', triggerType: 'cron' })

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(2)
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'trigger_fired',
			'agent-1',
			expect.objectContaining({
				model: 'claude-opus-5-5',
				model_source: 'agent',
				route: 'claude_oauth',
				trigger_id: 'trig-1',
				trigger_type: 'cron',
			}),
		)
	})

	it('swallows capture failures so session launch is never blocked', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))
		await expect(trackSessionLaunchModel(base)).resolves.toBeUndefined()
	})
})

describe('trackAgentSessionCompletedWithSkills', () => {
	it('carries duration_ms next to the outcome on the dev-backend emission', async () => {
		await trackAgentSessionCompletedWithSkills({
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			agentId: 'agent-1',
			outcome: 'completed',
			durationMs: 42_000,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_session_completed',
			'agent-1',
			expect.objectContaining({
				outcome: 'completed',
				duration_ms: 42_000,
				emitted_from: 'dev_backend',
			}),
		)
	})

	it('leaves duration_ms absent when the session has no start time', async () => {
		await trackAgentSessionCompletedWithSkills({
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			agentId: 'agent-1',
			outcome: 'failed',
		})

		const props = capturePosthogEventMock.mock.calls[0][2]
		expect(props.duration_ms).toBeUndefined()
	})
})
