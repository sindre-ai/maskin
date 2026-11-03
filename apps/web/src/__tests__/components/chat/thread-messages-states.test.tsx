import { render, screen, waitFor } from '@testing-library/react'
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
import { api } from '@/lib/api'

describe('ThreadMessages loading states', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: null,
		} as never)
	})

	it('offers a retry instead of the empty state when the fetch fails', async () => {
		// A failed fetch must not borrow "No messages yet — send the first
		// message": that tells a reader with a full thread it is empty and invites
		// them to start it over, with no way back but a manual reload.
		vi.mocked(api.conversations.messages).mockRejectedValue(new Error('network'))

		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: TestWrapper,
		})

		await waitFor(() =>
			expect(screen.getByText("Couldn't load this conversation")).toBeInTheDocument(),
		)
		expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
		expect(screen.queryByText('No messages yet')).not.toBeInTheDocument()
	})

	it('still shows the empty state for a genuinely empty thread', async () => {
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [],
			hasMore: false,
		} as never)

		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(screen.getByText('No messages yet')).toBeInTheDocument())
		expect(screen.queryByText("Couldn't load this conversation")).not.toBeInTheDocument()
	})
})
