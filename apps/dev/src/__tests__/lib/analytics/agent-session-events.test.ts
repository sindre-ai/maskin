import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	approximatePromptTokens,
	isRuntimeAgentSessionCompletedEnabled,
	trackAgentSessionCompleted,
	trackAgentSessionStartedWithPrompt,
} from '../../../lib/analytics/agent-session-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	Reflect.deleteProperty(process.env, 'RUNTIME_AGENT_SESSION_COMPLETED_ENABLED')
})

afterEach(() => {
	vi.restoreAllMocks()
	Reflect.deleteProperty(process.env, 'RUNTIME_AGENT_SESSION_COMPLETED_ENABLED')
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
		)
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
})

describe('isRuntimeAgentSessionCompletedEnabled', () => {
	it('returns false when the env var is unset', () => {
		expect(isRuntimeAgentSessionCompletedEnabled()).toBe(false)
	})

	it('returns true only for "1" or "true" (case-insensitive)', () => {
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = 'true'
		expect(isRuntimeAgentSessionCompletedEnabled()).toBe(true)
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = 'TRUE'
		expect(isRuntimeAgentSessionCompletedEnabled()).toBe(true)
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = '1'
		expect(isRuntimeAgentSessionCompletedEnabled()).toBe(true)
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = 'false'
		expect(isRuntimeAgentSessionCompletedEnabled()).toBe(false)
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = '0'
		expect(isRuntimeAgentSessionCompletedEnabled()).toBe(false)
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = ''
		expect(isRuntimeAgentSessionCompletedEnabled()).toBe(false)
	})
})

describe('trackAgentSessionCompleted', () => {
	it('does not emit when the runtime flag is off', async () => {
		await trackAgentSessionCompleted({
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			actorId: 'agent-1',
			outcome: 'completed',
		})

		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('emits an event that mirrors the frontend payload shape when the flag is on', async () => {
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = 'true'

		await trackAgentSessionCompleted({
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			actorId: 'agent-1',
			outcome: 'completed',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('agent_session_completed', 'agent-1', {
			entity_id: 'sess-1',
			entity_type: 'session',
			source: 'runtime',
			flow_id: null,
			outcome: 'completed',
			workspace_id: 'ws-1',
			actor_id: 'agent-1',
		})
	})

	it('preserves the outcome for the failed and timeout transitions', async () => {
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = '1'

		await trackAgentSessionCompleted({
			workspaceId: 'ws-1',
			sessionId: 'sess-2',
			actorId: 'agent-1',
			outcome: 'failed',
		})
		await trackAgentSessionCompleted({
			workspaceId: 'ws-1',
			sessionId: 'sess-3',
			actorId: 'agent-1',
			outcome: 'timeout',
		})

		expect(capturePosthogEventMock).toHaveBeenNthCalledWith(
			1,
			'agent_session_completed',
			'agent-1',
			expect.objectContaining({ entity_id: 'sess-2', outcome: 'failed' }),
		)
		expect(capturePosthogEventMock).toHaveBeenNthCalledWith(
			2,
			'agent_session_completed',
			'agent-1',
			expect.objectContaining({ entity_id: 'sess-3', outcome: 'timeout' }),
		)
	})

	it('swallows capture failures so the completion path is never blocked', async () => {
		process.env.RUNTIME_AGENT_SESSION_COMPLETED_ENABLED = 'true'
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))

		await expect(
			trackAgentSessionCompleted({
				workspaceId: 'ws-1',
				sessionId: 'sess-4',
				actorId: 'agent-1',
				outcome: 'completed',
			}),
		).resolves.toBeUndefined()
	})
})
