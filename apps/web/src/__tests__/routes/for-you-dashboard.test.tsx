import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../factories'

const mockUseUnread = vi.fn()
const mockMarkReadMutate = vi.fn()
const mockUseMarkRead = vi.fn()

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
	useMarkRead: (...args: unknown[]) => mockUseMarkRead(...args),
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
		mockUseMarkRead.mockReturnValue({ mutate: mockMarkReadMutate, isPending: false })
	})

	it('shows loading skeletons while loading', () => {
		mockUseUnread.mockReturnValue({ data: undefined, isLoading: true })
		render(<ForYouDashboard />)
		expect(screen.getAllByTestId('card-skeleton').length).toBeGreaterThan(0)
	})

	it('shows the empty state when there are no unread threads', () => {
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		expect(screen.getByText("You're all caught up")).toBeInTheDocument()
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

	it('marks every regular unread item read up to its latest event on "Mark all as read"', async () => {
		const user = userEvent.setup()
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({ entity_id: 'obj-1', latest_event_id: 10 }),
					buildUnreadItem({ entity_id: 'obj-2', latest_event_id: 22 }),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		await user.click(screen.getByRole('button', { name: /mark all as read/i }))
		expect(mockMarkReadMutate).toHaveBeenCalledTimes(2)
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 10,
		})
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-2',
			lastEventId: 22,
		})
	})
})
