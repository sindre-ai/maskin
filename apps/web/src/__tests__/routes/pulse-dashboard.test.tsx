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
	useDismissAllNotifications: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: (...args: unknown[]) => mockUseActors(...args),
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/components/pulse/pulse-card', () => ({
	PulseCard: ({ notification }: { notification: { title: string } }) => (
		<div data-testid="pulse-card">{notification.title}</div>
	),
}))

vi.mock('@/components/pulse/pulse-filters', () => ({
	PulseFilters: () => <div data-testid="pulse-filters" />,
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

const PulseDashboard = (Route as unknown as { component: React.FC }).component

describe('PulseDashboard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseActors.mockReturnValue({ data: [] })
	})

	it('shows loading skeletons when loading', () => {
		mockUseNotifications.mockReturnValue({ data: undefined, isLoading: true })
		render(<PulseDashboard />)
		expect(screen.getAllByTestId('card-skeleton')).toHaveLength(3)
	})

	it('shows empty state when no active notifications', () => {
		mockUseNotifications.mockReturnValue({ data: [], isLoading: false })
		render(<PulseDashboard />)
		expect(screen.getByText('No notifications yet')).toBeInTheDocument()
	})

	it('passes status filter to useNotifications', () => {
		mockUseNotifications.mockReturnValue({ data: [], isLoading: false })
		render(<PulseDashboard />)
		expect(mockUseNotifications).toHaveBeenCalledWith('ws-1', { status: 'pending,seen' })
	})

	it('renders pulse cards for pending/seen notifications', () => {
		const notifications = [
			buildNotificationResponse({ id: 'n-1', title: 'Pending One', status: 'pending' }),
			buildNotificationResponse({ id: 'n-2', title: 'Seen One', status: 'seen' }),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<PulseDashboard />)
		expect(screen.getAllByTestId('pulse-card')).toHaveLength(2)
		expect(screen.getByText('Pending One')).toBeInTheDocument()
		expect(screen.getByText('Seen One')).toBeInTheDocument()
	})

	it('renders all notifications returned by the API', () => {
		const notifications = [
			buildNotificationResponse({ id: 'n-1', title: 'Pending', status: 'pending' }),
			buildNotificationResponse({ id: 'n-2', title: 'Seen', status: 'seen' }),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<PulseDashboard />)
		expect(screen.getAllByTestId('pulse-card')).toHaveLength(2)
		expect(screen.getByText('Pending')).toBeInTheDocument()
		expect(screen.getByText('Seen')).toBeInTheDocument()
	})

	it('displays pending count message', () => {
		const notifications = [
			buildNotificationResponse({ id: 'n-1', status: 'pending' }),
			buildNotificationResponse({ id: 'n-2', status: 'pending' }),
			buildNotificationResponse({ id: 'n-3', status: 'seen' }),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<PulseDashboard />)
		expect(screen.getByText(/2 things need your attention/)).toBeInTheDocument()
	})

	it('renders pulse filters when notifications exist', () => {
		const notifications = [buildNotificationResponse({ id: 'n-1', status: 'pending' })]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<PulseDashboard />)
		expect(screen.getByTestId('pulse-filters')).toBeInTheDocument()
	})
})
