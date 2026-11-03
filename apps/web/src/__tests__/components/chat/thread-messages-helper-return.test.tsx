import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			get: vi.fn(),
			messages: vi.fn(),
		},
	},
}))

import { ThreadMessages } from '@/components/chat/thread-messages'
import type { MessageResponse } from '@/lib/api'
import { api } from '@/lib/api'

function buildMessage(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id,
		conversationId: 'conv-1',
		actorId: 'me',
		actorName: 'Me',
		actorType: 'human',
		kind: 'message',
		content: `message ${id}`,
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: new Date(2026, 0, 1, 0, 0, id).toISOString(),
		...overrides,
	}
}

describe('ThreadMessages — a helper result handed to its sender', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: null,
		} as never)
	})

	it('is not shown in the chat, while the messages around it are', async () => {
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [
				buildMessage(3, { content: 'The helper worked.', actorId: 'agent-1', actorName: 'Chief' }),
				buildMessage(2, {
					content: 'Gig Scout finished the work you handed it.',
					actorId: 'agent-2',
					actorName: 'Gig Scout',
					metadata: { helper_return: '11111111-1111-4111-8111-111111111111' },
				}),
				buildMessage(1, { content: 'Start Gig Scout.' }),
			],
			has_more: false,
		} as never)

		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: TestWrapper,
		})

		expect(await screen.findByText('Start Gig Scout.')).toBeInTheDocument()
		expect(screen.getByText('The helper worked.')).toBeInTheDocument()
		expect(screen.queryByText(/Gig Scout finished the work/)).not.toBeInTheDocument()
	})
})
