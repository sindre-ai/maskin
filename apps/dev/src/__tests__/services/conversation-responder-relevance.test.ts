import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSettings } from '../../lib/types'

const { chat, logger } = vi.hoisted(() => ({
	chat: vi.fn(),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../lib/logger', () => ({ logger }))
vi.mock('../../lib/llm/index', () => ({ createLLMAdapter: () => ({ chat }) }))

import { LlmNoEligibleHostError } from '../../lib/llm/adapter'
import { checkRelevance } from '../../services/conversation-responder'

function run(
	agent: { llmProvider: string | null; llmConfig: unknown } = {
		llmProvider: null,
		llmConfig: {},
	},
) {
	process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
	process.env.MASKIN_FALLBACK_ZDR = '1'
	return checkRelevance({
		agent: {
			id: 'agent-1',
			name: 'A',
			description: null,
			systemPrompt: null,
			...agent,
		},
		wsSettings: { billing: { plan: 'pro' } } as WorkspaceSettings,
		wsEntitlement: { enterpriseGranted: false, billingOwnerId: null },
		conversationHistory: [],
		newMessageContent: 'hello',
		isDirectConversation: false,
	})
}

describe('checkRelevance with a no-eligible-host error', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('fails open (responds) when the adapter reports no eligible host', async () => {
		chat.mockRejectedValue(new LlmNoEligibleHostError('no host, unset MASKIN_FALLBACK_ZDR'))
		await expect(run()).resolves.toEqual({ respond: true, reason: 'default_yes_check_error' })
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Conversation relevance check call failed'),
			expect.objectContaining({ agentId: 'agent-1' }),
		)
	})
})

describe('checkRelevance reasons', () => {
	const keyed = { llmProvider: 'anthropic', llmConfig: { api_key: 'sk-test' } }
	const decide = (should_respond: boolean) => ({
		tool_calls: [{ name: 'decide_response', arguments: { should_respond } }],
	})

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([
		['model_yes', true, () => chat.mockResolvedValue(decide(true))],
		['model_no', false, () => chat.mockResolvedValue(decide(false))],
		['model_no_decision', false, () => chat.mockResolvedValue({ tool_calls: [] })],
		['default_yes_check_error', true, () => chat.mockRejectedValue(new Error('network down'))],
	])('reads %s', async (reason, respond, arrange) => {
		arrange()
		await expect(run(keyed)).resolves.toEqual({ respond, reason })
	})

	it('reads default_yes_no_credentials when no chat-callable credential exists', async () => {
		const result = await checkRelevance({
			agent: {
				id: 'agent-1',
				name: 'A',
				description: null,
				systemPrompt: null,
				llmProvider: null,
				llmConfig: {},
			},
			// An enterprise workspace may not draw on Maskin's key, so nothing resolves.
			wsSettings: { billing: { plan: 'enterprise' } } as WorkspaceSettings,
			wsEntitlement: { enterpriseGranted: true, billingOwnerId: null },
			conversationHistory: [],
			newMessageContent: 'hello',
			isDirectConversation: false,
		})
		expect(result).toEqual({ respond: true, reason: 'default_yes_no_credentials' })
		expect(chat).not.toHaveBeenCalled()
	})
})
