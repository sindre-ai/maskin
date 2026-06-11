import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../factories'

const mockUseUnread = vi.fn()
const mockMarkReadMutate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: (...args: unknown[]) => mockUseUnread(...args),
	useMarkRead: () => ({ mutate: mockMarkReadMutate, isPending: false }),
}))

vi.mock('@/components/foryou/persistent-reply-bar', () => ({
	PersistentReplyBar: () => null,
}))

vi.mock('@/components/foryou/new-conversation-composer', () => ({
	NewConversationComposer: () => null,
}))

vi.mock('@/components/foryou/unread-thread-card', () => ({
	UnreadThreadCard: ({ item }: { item: UnreadItem }) => (
		<div data-testid="unread-thread-card">{item.entity_id}</div>
	),
}))

vi.mock('@/components/shared/empty-state', () => ({
	EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))

vi.mock('@/components/shared/loading-skeleton', () => ({
	CardSkeleton: () => <div data-testid="card-skeleton" />,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/index'

const ForYouDashboard = (Route as unknown as { component: React.FC }).component

function buildUnreadItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 1,
		mentions_you: false,
		latest_event_id: 10,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({ id: 'obj-1', title: 'Test Bet' }),
		...overrides,
	}
}

describe('ForYouDashboard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows loading skeletons while loading', () => {
		mockUseUnread.mockReturnValue({ data: undefined, isLoading: true })
		render(<ForYouDashboard />)
		expect(screen.getAllByTestId('card-skeleton').length).toBeGreaterThan(0)
	})

	it('shows the empty state when there are no unread threads', () => {
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		expect(screen.getByText('All caught up')).toBeInTheDocument()
	})

	it('renders one UnreadThreadCard per unread item', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [buildUnreadItem({ entity_id: 'obj-1' }), buildUnreadItem({ entity_id: 'obj-2' })],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		expect(screen.getAllByTestId('unread-thread-card')).toHaveLength(2)
		expect(screen.getByText('obj-1')).toBeInTheDocument()
		expect(screen.getByText('obj-2')).toBeInTheDocument()
	})

	it('sorts mentions_you items above non-mention items', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({ entity_id: 'fyi-1', mentions_you: false }),
					buildUnreadItem({ entity_id: 'mention-1', mentions_you: true }),
					buildUnreadItem({ entity_id: 'fyi-2', mentions_you: false }),
					buildUnreadItem({ entity_id: 'mention-2', mentions_you: true }),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		const rendered = screen.getAllByTestId('unread-thread-card').map((el) => el.textContent)
		expect(rendered).toEqual(['mention-1', 'mention-2', 'fyi-1', 'fyi-2'])
	})

	it('fires markRead.mutate once per item with correct args when "Mark all read" is clicked', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({
						entity_type: 'object',
						entity_id: 'obj-1',
						unread_count: 2,
						latest_event_id: 11,
					}),
					buildUnreadItem({
						entity_type: 'object',
						entity_id: 'obj-2',
						unread_count: 1,
						latest_event_id: 22,
					}),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
		expect(mockMarkReadMutate).toHaveBeenCalledTimes(2)
		expect(mockMarkReadMutate).toHaveBeenNthCalledWith(1, {
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 11,
		})
		expect(mockMarkReadMutate).toHaveBeenNthCalledWith(2, {
			entityType: 'object',
			entityId: 'obj-2',
			lastEventId: 22,
		})
	})
})
