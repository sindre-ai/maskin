import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../factories'

const mockUseUnread = vi.fn()

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
}))

vi.mock('@/components/foryou/unread-thread-card', () => ({
	UnreadThreadCard: ({ item }: { item: UnreadItem }) => (
		<div data-testid="unread-thread-card">{item.entity_id}</div>
	),
}))

vi.mock('@/components/foryou/sparse-composer', () => ({
	SparseComposer: ({ itemsCount }: { itemsCount: number }) => (
		<div data-testid="sparse-composer" data-items-count={itemsCount} />
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

	it('renders the sparse composer with items_count=0 on the empty state (AC-U1)', () => {
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		const composer = screen.getByTestId('sparse-composer')
		expect(composer).toBeInTheDocument()
		expect(composer).toHaveAttribute('data-items-count', '0')
	})

	it('renders the sparse composer below items when 1 ≤ items.length < 3 (AC-U2)', () => {
		mockUseUnread.mockReturnValue({
			data: { items: [buildUnreadItem({ entity_id: 'obj-1' })] },
			isLoading: false,
		})
		render(<ForYouDashboard />)
		const composer = screen.getByTestId('sparse-composer')
		expect(composer).toHaveAttribute('data-items-count', '1')
	})

	it('hides the sparse composer when items.length >= 3 (AC-U3)', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({ entity_id: 'obj-1' }),
					buildUnreadItem({ entity_id: 'obj-2' }),
					buildUnreadItem({ entity_id: 'obj-3' }),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		expect(screen.queryByTestId('sparse-composer')).not.toBeInTheDocument()
	})
})
