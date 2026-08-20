import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	approximatePromptTokens,
	trackAgentSessionStartedWithPrompt,
} from '../../../lib/analytics/agent-session-events'

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
			},
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
