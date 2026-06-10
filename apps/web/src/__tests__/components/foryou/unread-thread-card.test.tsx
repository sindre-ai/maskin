import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { EventResponse, UnreadItem } from '@/lib/api'
import { buildEventResponse, buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockUseEntityEvents = vi.fn()
const mockMarkReadMutate = vi.fn()
const mockUseMarkRead = vi.fn(() => ({ mutate: mockMarkReadMutate, isPending: false }))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: (...args: unknown[]) => mockUseEntityEvents(...args),
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useMarkRead: () => mockUseMarkRead(),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'viewer', name: 'Viewer', type: 'human', email: null }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({
		data: { id: 'other', name: 'Other', type: 'human' },
	}),
	useActors: () => ({
		data: [
			{ id: 'viewer', name: 'Viewer', type: 'human', isSystem: false },
			{ id: 'other', name: 'Other', type: 'human', isSystem: false },
		],
	}),
}))

import { UnreadThreadCard } from '@/components/foryou/unread-thread-card'

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 1,
		mentions_you: false,
		latest_event_id: 20,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({ id: 'obj-1', title: 'Onboarding A/B', type: 'bet' }),
		...overrides,
	}
}

function buildComment(overrides: Partial<EventResponse> = {}) {
	return buildEventResponse({
		action: 'commented',
		entityType: 'object',
		entityId: 'obj-1',
		data: { content: 'Hello' },
		...overrides,
	})
}

const noop = () => {}

describe('UnreadThreadCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMarkReadMutate.mockReset()
	})

	it('renders the object title and unread count', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 3 })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Onboarding A/B')).toBeInTheDocument()
		expect(screen.getByLabelText('3 unread')).toBeInTheDocument()
	})

	it('renders a "Mentioned" badge when the unread thread mentions the viewer', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ mentions_you: true })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByLabelText('Mentioned')).toBeInTheDocument()
	})

	it('omits the "Mentioned" badge when mentions_you is false', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ mentions_you: false })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByLabelText('Mentioned')).not.toBeInTheDocument()
	})

	it('renders a "New" divider before the first thread containing unread activity', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 30, actorId: 'other', data: { content: 'newer' } }),
				buildComment({ id: 20, actorId: 'other', data: { content: 'middle' } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'oldest' } }),
			],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 2 })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByLabelText('Unread divider')).toBeInTheDocument()
	})

	it('renders no divider when there is no unread activity in the loaded events', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [buildComment({ id: 10, actorId: 'viewer', data: { content: 'mine' } })],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 0 })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByLabelText('Unread divider')).not.toBeInTheDocument()
	})

	it('renders no per-card reply textarea', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard workspaceId="ws-1" item={buildItem()} isActive={false} onActivate={noop} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('renders a Reply button in the footer', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard workspaceId="ws-1" item={buildItem()} isActive={false} onActivate={noop} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /reply/i })).toBeInTheDocument()
	})

	it('shows "Replying…" on the Reply button when isActive is true', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard workspaceId="ws-1" item={buildItem()} isActive={true} onActivate={noop} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /replying/i })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^reply$/i })).not.toBeInTheDocument()
	})

	it('applies active ring styling when isActive is true', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard workspaceId="ws-1" item={buildItem()} isActive={true} onActivate={noop} />,
			{ wrapper: TestWrapper },
		)
		// The outer wrapper is the firstChild; the inner card is the second child of the wrapper.
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).toMatch(/border-ring/)
	})

	it('does not apply ring styling when isActive is false', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard workspaceId="ws-1" item={buildItem()} isActive={false} onActivate={noop} />,
			{ wrapper: TestWrapper },
		)
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).not.toMatch(/border-ring/)
	})

	it('calls onActivate when the card body is clicked', async () => {
		const user = userEvent.setup()
		const onActivate = vi.fn()
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={onActivate}
			/>,
			{ wrapper: TestWrapper },
		)
		// Click on the inner card (second child of the wrapper)
		const card = container.firstChild?.childNodes[1] as HTMLElement
		await user.click(card)
		expect(onActivate).toHaveBeenCalled()
	})

	it('calls onActivate when the Reply button is clicked', async () => {
		const user = userEvent.setup()
		const onActivate = vi.fn()
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={onActivate}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.click(screen.getByRole('button', { name: /reply/i }))
		expect(onActivate).toHaveBeenCalled()
	})

	it('renders the "New" divider inside the thread when only a reply is unread', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({
					id: 20,
					actorId: 'other',
					data: { content: 'reply unread', parentEventId: 10 },
				}),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'root read' } }),
			],
		})
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1 })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const divider = container.querySelector('[aria-label="Unread divider"]')
		expect(divider).not.toBeNull()
		const replyColumn = divider?.closest('.ml-7')
		expect(replyColumn).not.toBeNull()
	})

	it('still renders a divider when unread_count exceeds the loaded events', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 20, actorId: 'other', data: { content: 'newer' } }),
				buildComment({ id: 10, actorId: 'other', data: { content: 'older' } }),
			],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 5 })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByLabelText('Unread divider')).toBeInTheDocument()
	})

	it('does not mark the thread as read on mount', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [buildComment({ id: 30, actorId: 'other', data: { content: 'newer' } })],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1 })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(mockMarkReadMutate).not.toHaveBeenCalled()
	})

	it('marks the thread as read when the "Mark as read" button is clicked', async () => {
		const user = userEvent.setup()
		mockUseEntityEvents.mockReturnValue({
			data: [buildComment({ id: 42, actorId: 'other', data: { content: 'unread' } })],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1, latest_event_id: 42 })}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)

		await user.click(screen.getByRole('button', { name: /mark as read/i }))
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 42,
		})
	})

	it('shows the bet context pill for bet-type objects', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({ id: 'obj-1', title: 'My Bet', type: 'bet' }),
				})}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('B')).toBeInTheDocument()
	})

	it('omits the bet context pill for non-bet objects', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({ id: 'obj-1', title: 'My Task', type: 'task' }),
				})}
				isActive={false}
				onActivate={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByText('B')).not.toBeInTheDocument()
	})

	it('renders the swipe-to-mark-read green background element', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard workspaceId="ws-1" item={buildItem()} isActive={false} onActivate={noop} />,
			{ wrapper: TestWrapper },
		)
		// The green reveal background is the first child of the outer wrapper
		const wrapper = container.firstChild as HTMLElement
		const swipeBg = wrapper.firstChild as HTMLElement
		expect(swipeBg).toHaveAttribute('aria-hidden')
	})

	it('renders Mark as read button in the card footer', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard workspaceId="ws-1" item={buildItem()} isActive={false} onActivate={noop} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /mark as read/i })).toBeInTheDocument()
	})
})
