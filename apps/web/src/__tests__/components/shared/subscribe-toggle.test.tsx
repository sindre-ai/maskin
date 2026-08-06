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

vi.mock('@/lib/auth', async () => {
	const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
	return {
		...actual,
		getStoredActor: vi.fn(() => ({ id: 'a1', name: 'Alice', type: 'human', email: null })),
	}
})

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

		await waitFor(() => expect(screen.getByText('AL')).toBeInTheDocument())
		expect(screen.getByText('BO')).toBeInTheDocument()
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

	it('calls subscribe when the + button is clicked', async () => {
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

	it('hides the + button when already subscribed', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({
			actors: [{ id: 'a1', type: 'human', name: 'Alice' }],
		})

		render(
			<SubscribeToggle
				workspaceId="ws-1"
				entityType="object"
				entityId="obj-1"
				isSubscribed={true}
			/>,
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(screen.getByText('AL')).toBeInTheDocument())
		expect(screen.queryByRole('button', { name: /^subscribe/i })).not.toBeInTheDocument()
	})

	it('calls unsubscribe when the current actor clicks their own avatar', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({
			actors: [
				{ id: 'a1', type: 'human', name: 'Alice' },
				{ id: 'a2', type: 'human', name: 'Bob' },
			],
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

	it('shows a fallback unsubscribe button when current actor is in the overflow', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({
			actors: [
				{ id: 'a2', type: 'human', name: 'Bob' },
				{ id: 'a3', type: 'human', name: 'Carol' },
				{ id: 'a4', type: 'human', name: 'Dave' },
				{ id: 'a5', type: 'human', name: 'Eve' },
				{ id: 'a1', type: 'human', name: 'Alice' },
			],
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

		await waitFor(() => expect(screen.getByText('+1')).toBeInTheDocument())
		const button = await screen.findByRole('button', { name: /unsubscribe/i })
		fireEvent.click(button)
		await waitFor(() =>
			expect(api.subscriptions.unsubscribe).toHaveBeenCalledWith('ws-1', 'object', 'obj-1'),
		)
	})

	it('does not make other actors clickable', async () => {
		vi.mocked(api.subscriptions.subscribers).mockResolvedValue({
			actors: [{ id: 'a2', type: 'human', name: 'Bob' }],
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

		await waitFor(() => expect(screen.getByText('BO')).toBeInTheDocument())
		expect(screen.queryByRole('button', { name: /unsubscribe/i })).not.toBeInTheDocument()
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
