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

function run() {
	process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
	process.env.MASKIN_FALLBACK_ZDR = '1'
	return checkRelevance({
		agent: {
			id: 'agent-1',
			name: 'A',
			description: null,
			systemPrompt: null,
			llmProvider: null,
			llmConfig: {},
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
		await expect(run()).resolves.toBe(true)
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Conversation relevance check call failed'),
			expect.objectContaining({ agentId: 'agent-1' }),
		)
	})
})
