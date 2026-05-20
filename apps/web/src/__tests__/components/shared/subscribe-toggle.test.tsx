import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		subscriptions: {
			subscribe: vi.fn(),
			unsubscribe: vi.fn(),
			subscribers: vi.fn(),
			markRead: vi.fn(),
			unread: vi.fn(),
		},
	},
}))

import { SubscribeToggle } from '@/components/shared/subscribe-toggle'
import { api } from '@/lib/api'
import { TestWrapper } from '../../setup'

describe('SubscribeToggle', () => {
	beforeEach(() => vi.clearAllMocks())

	it('renders an avatar stack for current subscribers', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({
			actors: [
				{ id: 'a1', type: 'human', name: 'Alice' },
				{ id: 'a2', type: 'agent', name: 'Bot' },
			],
		})

		render(
			<SubscribeToggle
				workspaceId="ws-1"
				entityType="object"
				entityId="obj-1"
				isSubscribed={false}
			/>,
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument())
		expect(screen.getByText('⚡')).toBeInTheDocument()
	})

	it('shows a +N chip when there are more subscribers than the cap', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({
			actors: [
				{ id: 'a1', type: 'human', name: 'A' },
				{ id: 'a2', type: 'human', name: 'B' },
				{ id: 'a3', type: 'human', name: 'C' },
				{ id: 'a4', type: 'human', name: 'D' },
				{ id: 'a5', type: 'human', name: 'E' },
				{ id: 'a6', type: 'human', name: 'F' },
			],
		})

		render(
			<SubscribeToggle
				workspaceId="ws-1"
				entityType="object"
				entityId="obj-1"
				isSubscribed={false}
			/>,
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(screen.getByText('+2')).toBeInTheDocument())
	})

	it('calls subscribe when not subscribed and the toggle is clicked', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({ actors: [] })
		vi.mocked(api.subscriptions.subscribe).mockResolvedValue({ subscribed: true })

		render(
			<SubscribeToggle
				workspaceId="ws-1"
				entityType="object"
				entityId="obj-1"
				isSubscribed={false}
			/>,
			{ wrapper: TestWrapper },
		)

		const button = await screen.findByRole('button', { name: /subscribe/i })
		fireEvent.click(button)
		await waitFor(() =>
			expect(api.subscriptions.subscribe).toHaveBeenCalledWith('ws-1', 'object', 'obj-1'),
		)
	})

	it('calls unsubscribe when already subscribed', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({
			actors: [{ id: 'a1', type: 'human', name: 'Alice' }],
		})
		vi.mocked(api.subscriptions.unsubscribe).mockResolvedValue({ unsubscribed: true })

		render(
			<SubscribeToggle
				workspaceId="ws-1"
				entityType="object"
				entityId="obj-1"
				isSubscribed={true}
			/>,
			{ wrapper: TestWrapper },
		)

		const button = await screen.findByRole('button', { name: /unsubscribe/i })
		fireEvent.click(button)
		await waitFor(() =>
			expect(api.subscriptions.unsubscribe).toHaveBeenCalledWith('ws-1', 'object', 'obj-1'),
		)
	})

	it('accepts arbitrary entityType (entity-agnostic)', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({ actors: [] })

		render(
			<SubscribeToggle
				workspaceId="ws-1"
				entityType="thread"
				entityId="thread-1"
				isSubscribed={false}
			/>,
			{ wrapper: TestWrapper },
		)

		await waitFor(() =>
			expect(api.subscriptions.subscribers).toHaveBeenCalledWith('ws-1', 'thread', 'thread-1'),
		)
	})
})
