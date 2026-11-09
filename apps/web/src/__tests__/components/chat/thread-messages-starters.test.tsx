import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: { get: vi.fn(), messages: vi.fn() },
		actors: { list: vi.fn() },
	},
}))

import { ThreadMessages } from '@/components/chat/thread-messages'
import { api } from '@/lib/api'

const me = { actorId: 'me', actorName: 'Me', actorType: 'human' }
const relay = { actorId: 'agent-1', actorName: 'Relay', actorType: 'agent' }
const sam = { actorId: 'sam', actorName: 'Sam', actorType: 'human' }

const agents = [
	{
		id: 'agent-1',
		type: 'agent',
		name: 'Relay',
		starter_prompts: ['What needs me today?', 'Summarise the open decisions'],
	},
]

function conversation(participants: unknown[]) {
	vi.mocked(api.conversations.get).mockResolvedValue({
		id: 'conv-1',
		participants,
		last_read_message_id: null,
	} as never)
}

describe('ThreadMessages starter prompts in an empty thread', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(api.actors.list).mockReset()
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [],
			hasMore: false,
		} as never)
		vi.mocked(api.actors.list).mockResolvedValue(agents as never)
	})

	it('offers the one agent’s prompts, and a tap hands the exact text to onPickStarter', async () => {
		conversation([me, relay])
		const onPickStarter = vi.fn()
		const onPickStep = vi.fn()
		render(
			<ThreadMessages
				workspaceId="ws-1"
				conversationId="conv-1"
				onPickStarter={onPickStarter}
				onPickStep={onPickStep}
			/>,
			{ wrapper: TestWrapper },
		)

		const chip = await screen.findByRole('button', { name: 'What needs me today?' })
		expect(screen.getByText('No messages yet')).toBeInTheDocument()
		fireEvent.click(chip)
		expect(onPickStarter).toHaveBeenCalledWith('What needs me today?')
		// Not the fill-step handler, which replaces the draft.
		expect(onPickStep).not.toHaveBeenCalled()
	})

	it('shows no chips where the caller gave no composer to fill', async () => {
		conversation([me, relay])
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(screen.getByText('No messages yet')).toBeInTheDocument())
		expect(screen.queryByTestId('starter-prompts')).not.toBeInTheDocument()
	})

	it('holds the empty state until the actor list has answered, so nothing pops in', async () => {
		conversation([me, relay])
		vi.mocked(api.actors.list).mockReturnValue(new Promise(() => {}) as never)
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" onPickStarter={vi.fn()} />, {
			wrapper: TestWrapper,
		})
		// Give the messages and the conversation time to settle; the actors never do.
		await waitFor(() => expect(api.conversations.get).toHaveBeenCalled())
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(screen.queryByText('No messages yet')).not.toBeInTheDocument()
		expect(screen.queryByTestId('starter-prompts')).not.toBeInTheDocument()
	})

	it('settles with no chips when the actor list fails', async () => {
		conversation([me, relay])
		vi.mocked(api.actors.list).mockRejectedValue(new Error('network'))
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" onPickStarter={vi.fn()} />, {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(screen.getByText('No messages yet')).toBeInTheDocument())
		expect(screen.queryByTestId('starter-prompts')).not.toBeInTheDocument()
	})

	it('offers none in a group, or in a chat with a person', async () => {
		conversation([me, relay, sam])
		const { unmount } = render(
			<ThreadMessages workspaceId="ws-1" conversationId="conv-1" onPickStarter={vi.fn()} />,
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(screen.getByText('No messages yet')).toBeInTheDocument())
		expect(screen.queryByTestId('starter-prompts')).not.toBeInTheDocument()
		unmount()

		conversation([me, sam])
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" onPickStarter={vi.fn()} />, {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(screen.getByText('No messages yet')).toBeInTheDocument())
		expect(screen.queryByTestId('starter-prompts')).not.toBeInTheDocument()
	})
})
