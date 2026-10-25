import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSettings } from '../../lib/types'

const { chat, logger } = vi.hoisted(() => ({
	chat: vi.fn(),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../lib/logger', () => ({ logger }))
vi.mock('../../lib/llm/index', () => ({ createLLMAdapter: () => ({ chat }) }))

import { chooseResponder } from '../../services/conversation-responder'

const candidates = ['a', 'b'].map((id) => ({
	id: `agent-${id}`,
	name: id.toUpperCase(),
	description: null,
	systemPrompt: null,
	llmProvider: null,
	llmConfig: {},
}))

function run() {
	process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
	process.env.MASKIN_FALLBACK_ZDR = '1'
	return chooseResponder({
		candidates,
		wsSettings: { billing: { plan: 'pro' } } as WorkspaceSettings,
		wsEntitlement: { enterpriseGranted: false, billingOwnerId: null },
		conversationHistory: [],
		newMessageContent: 'hello',
	})
}

describe('chooseResponder', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('returns the single agent the model picks', async () => {
		chat.mockResolvedValue({
			tool_calls: [{ name: 'choose_responder', arguments: { agent_id: 'agent-b' } }],
		})
		await expect(run()).resolves.toBe('agent-b')
	})

	it('returns null when the model picks nobody', async () => {
		chat.mockResolvedValue({
			tool_calls: [{ name: 'choose_responder', arguments: { agent_id: null } }],
		})
		await expect(run()).resolves.toBeNull()
	})

	it('returns null for an id that is not a candidate', async () => {
		chat.mockResolvedValue({
			tool_calls: [{ name: 'choose_responder', arguments: { agent_id: 'agent-z' } }],
		})
		await expect(run()).resolves.toBeNull()
	})

	it('fails closed when the call throws', async () => {
		chat.mockRejectedValue(new Error('provider down'))
		await expect(run()).resolves.toBeNull()
		expect(logger.error).toHaveBeenCalled()
	})
})
