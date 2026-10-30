import { beforeEach, describe, expect, it, vi } from 'vitest'

const { insertMock, flag } = vi.hoisted(() => ({
	insertMock: vi.fn(async () => ({ id: 1 })),
	flag: { on: true },
}))

vi.mock('../../services/conversation-messages', () => ({ insertConversationMessage: insertMock }))
vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../config/chat-resume', () => ({
	get CHAT_RESUME_INTERIM_MESSAGE_ENABLED() {
		return flag.on
	},
}))

import { buildRetryNotice, postRetryNotice } from '../../services/chat-retry-notice'

const NOW = new Date('2026-10-28T10:00:00Z')

describe('buildRetryNotice', () => {
	it('gives the time of day when the retry is within a day', () => {
		expect(buildRetryNotice(new Date('2026-10-28T14:30:00Z'), NOW)).toBe(
			'Claude is at its usage limit. Your last message will be tried again at 14:30 UTC.',
		)
	})

	it('adds the date for a weekly reset', () => {
		expect(buildRetryNotice(new Date('2026-10-31T13:00:00Z'), NOW)).toBe(
			'Claude is at its usage limit. Your last message will be tried again at Oct 31, 13:00 UTC.',
		)
	})
})

describe('postRetryNotice', () => {
	beforeEach(() => {
		insertMock.mockClear()
		flag.on = true
	})

	const args = {
		conversationId: 'conv-1',
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		retryAt: new Date('2026-10-28T14:30:00Z'),
	}

	it('posts a system message into the conversation', async () => {
		await postRetryNotice({} as never, args)
		expect(insertMock).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				conversationId: 'conv-1',
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				kind: 'system',
				sessionId: null,
			}),
		)
	})

	it('stays silent when the config flag is off', async () => {
		flag.on = false
		await postRetryNotice({} as never, args)
		expect(insertMock).not.toHaveBeenCalled()
	})

	it('swallows a failed insert so the settle is not failed', async () => {
		insertMock.mockRejectedValueOnce(new Error('db down'))
		await expect(postRetryNotice({} as never, args)).resolves.toBeUndefined()
	})
})
