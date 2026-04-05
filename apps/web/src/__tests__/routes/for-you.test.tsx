import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { buildNotificationResponse } from '../factories'

const mockUseNotifications = vi.fn()
const mockUseActors = vi.fn()

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

vi.mock('@/hooks/use-notifications', () => ({
	useNotifications: (...args: unknown[]) => mockUseNotifications(...args),
	useRespondNotification: () => ({ mutate: vi.fn() }),
	useUpdateNotification: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: (...args: unknown[]) => mockUseActors(...args),
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/components/notifications/notification-card', () => ({
	NotificationCard: ({ notification }: { notification: { title: string } }) => (
		<div data-testid="notification-card">{notification.title}</div>
	),
}))

vi.mock('@/components/notifications/notification-filters', () => ({
	NotificationFilters: () => <div data-testid="notification-filters" />,
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

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: () => null,
}))

import { Route } from '@/routes/_authed/$workspaceId/index'

const ForYouPage = (Route as unknown as { component: React.FC }).component

describe('ForYouPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseActors.mockReturnValue({ data: [] })
	})

	it('shows loading skeletons when loading', () => {
		mockUseNotifications.mockReturnValue({ data: undefined, isLoading: true })
		render(<ForYouPage />)
		expect(screen.getAllByTestId('card-skeleton')).toHaveLength(3)
	})

	it('shows empty state when no active notifications', () => {
		mockUseNotifications.mockReturnValue({ data: [], isLoading: false })
		render(<ForYouPage />)
		expect(screen.getByText('No notifications yet')).toBeInTheDocument()
	})

	it('renders notification cards for pending/seen notifications', () => {
		const notifications = [
			buildNotificationResponse({ id: 'n-1', title: 'Pending One', status: 'pending' }),
			buildNotificationResponse({ id: 'n-2', title: 'Seen One', status: 'seen' }),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<ForYouPage />)
		expect(screen.getAllByTestId('notification-card')).toHaveLength(2)
		expect(screen.getByText('Pending One')).toBeInTheDocument()
		expect(screen.getByText('Seen One')).toBeInTheDocument()
	})

	it('filters out resolved and dismissed notifications', () => {
		const notifications = [
			buildNotificationResponse({ id: 'n-1', title: 'Active', status: 'pending' }),
			buildNotificationResponse({ id: 'n-2', title: 'Resolved', status: 'resolved' }),
			buildNotificationResponse({ id: 'n-3', title: 'Dismissed', status: 'dismissed' }),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<ForYouPage />)
		expect(screen.getAllByTestId('notification-card')).toHaveLength(1)
		expect(screen.getByText('Active')).toBeInTheDocument()
		expect(screen.queryByText('Resolved')).not.toBeInTheDocument()
	})

	it('displays pending count message', () => {
		const notifications = [
			buildNotificationResponse({ id: 'n-1', status: 'pending' }),
			buildNotificationResponse({ id: 'n-2', status: 'pending' }),
			buildNotificationResponse({ id: 'n-3', status: 'seen' }),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<ForYouPage />)
		expect(screen.getByText(/2 things need your attention/)).toBeInTheDocument()
	})

	it('renders notification filters when notifications exist', () => {
		const notifications = [buildNotificationResponse({ id: 'n-1', status: 'pending' })]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<ForYouPage />)
		expect(screen.getByTestId('notification-filters')).toBeInTheDocument()
	})
})
