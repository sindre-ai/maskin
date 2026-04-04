import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { buildIntegrationResponse } from '../factories'

const mockUseIntegrations = vi.fn()
const mockUseProviders = vi.fn()

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

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: (...args: unknown[]) => mockUseIntegrations(...args),
	useProviders: () => mockUseProviders(),
	useConnectIntegration: () => ({ mutate: vi.fn(), isPending: false }),
	useDisconnectIntegration: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/components/shared/empty-state', () => ({
	EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))

vi.mock('@/components/shared/loading-skeleton', () => ({
	ListSkeleton: () => <div data-testid="list-skeleton" />,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/integrations'

const IntegrationsPage = (Route as unknown as { component: React.FC }).component

describe('IntegrationsPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows loading state', () => {
		mockUseIntegrations.mockReturnValue({ data: undefined, isLoading: true })
		mockUseProviders.mockReturnValue({ data: undefined, isLoading: true })
		render(<IntegrationsPage />)
		expect(screen.getByTestId('list-skeleton')).toBeInTheDocument()
	})

	it('shows empty state when no providers available', () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({ data: [], isLoading: false })
		render(<IntegrationsPage />)
		expect(screen.getByText('No providers available')).toBeInTheDocument()
	})

	it('renders provider list with display names', () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [
				{ name: 'slack', displayName: 'Slack', events: [] },
				{ name: 'github', displayName: 'GitHub', events: [{ type: 'push' }] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		expect(screen.getByText('Slack')).toBeInTheDocument()
		expect(screen.getByText('GitHub')).toBeInTheDocument()
	})

	it('shows Connect for disconnected and Disconnect for connected providers', () => {
		const integration = buildIntegrationResponse({
			provider: 'slack',
			status: 'active',
		})
		mockUseIntegrations.mockReturnValue({ data: [integration], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [
				{ name: 'slack', displayName: 'Slack', events: [] },
				{ name: 'github', displayName: 'GitHub', events: [] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
	})
})
