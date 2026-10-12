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

describe('ThreadMessages — backward pagination', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: null,
		} as never)
	})

	it('surfaces the "Load older messages" button when the server says more exist', async () => {
		// A page with has_more=true is the frontend's only signal that older
		// messages are still on the server — the button is the accessible
		// fallback path for keyboard users and for environments where the
		// top-sentinel IntersectionObserver never fires.
		const messages = Array.from({ length: 50 }, (_, i) => buildMessage(50 - i))
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages,
			has_more: true,
		} as never)

		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: TestWrapper,
		})

		expect(await screen.findByRole('button', { name: /Load older messages/ })).toBeInTheDocument()
	})

	it('hides the button once the server has no more messages to hand out', async () => {
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [buildMessage(1), buildMessage(2)],
			has_more: false,
		} as never)

		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(screen.getByText('message 1')).toBeInTheDocument())
		expect(screen.queryByRole('button', { name: /Load older messages/ })).not.toBeInTheDocument()
	})

	it('renders a top sentinel above the button so the IntersectionObserver can auto-load', async () => {
		// The sentinel is what makes older-message loading discoverable without
		// forcing the reader to spot the button — the reported bug ("Older
		// messages cannot be loaded") was the button sitting invisibly at the
		// top of an auto-scrolled-to-bottom thread. The sentinel + observer is
		// the standard chat-surface pattern (WhatsApp, Slack, Messenger).
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: Array.from({ length: 50 }, (_, i) => buildMessage(50 - i)),
			has_more: true,
		} as never)

		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: TestWrapper,
		})

		await screen.findByRole('button', { name: /Load older messages/ })
		expect(screen.getByTestId('thread-messages-top-sentinel')).toBeInTheDocument()
	})
})
