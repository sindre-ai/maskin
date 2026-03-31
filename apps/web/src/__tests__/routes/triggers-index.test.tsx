import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { buildActorResponse, buildTriggerResponse } from '../factories'

const mockUseTriggers = vi.fn()
const mockUseActors = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: any) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: (...args: any[]) => mockUseTriggers(...args),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: (...args: any[]) => mockUseActors(...args),
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
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

import { Route } from '@/routes/_authed/$workspaceId/triggers/index'

const TriggersPage = Route.component as React.FC

describe('TriggersPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseActors.mockReturnValue({ data: [] })
	})

	it('shows loading skeleton when triggers are loading', () => {
		mockUseTriggers.mockReturnValue({ data: undefined, isLoading: true })
		render(<TriggersPage />)
		expect(screen.getByTestId('list-skeleton')).toBeInTheDocument()
	})

	it('shows empty state when no triggers', () => {
		mockUseTriggers.mockReturnValue({ data: [], isLoading: false })
		render(<TriggersPage />)
		expect(screen.getByText('No triggers')).toBeInTheDocument()
	})

	it('renders trigger rows with name, type, and agent name', () => {
		const agent = buildActorResponse({ id: 'agent-1', name: 'My Agent', type: 'agent' })
		const trigger = buildTriggerResponse({
			name: 'Daily Sync',
			type: 'cron',
			targetActorId: 'agent-1',
		})
		mockUseTriggers.mockReturnValue({ data: [trigger], isLoading: false })
		mockUseActors.mockReturnValue({ data: [agent] })
		render(<TriggersPage />)
		expect(screen.getByText('Daily Sync')).toBeInTheDocument()
		expect(screen.getByText(/cron → My Agent/)).toBeInTheDocument()
	})

	it('shows "Unknown" when agent is not found', () => {
		const trigger = buildTriggerResponse({
			name: 'Orphan Trigger',
			targetActorId: 'missing-agent',
		})
		mockUseTriggers.mockReturnValue({ data: [trigger], isLoading: false })
		mockUseActors.mockReturnValue({ data: [] })
		render(<TriggersPage />)
		expect(screen.getByText(/Unknown/)).toBeInTheDocument()
	})

	it('renders enabled indicator for enabled triggers', () => {
		const trigger = buildTriggerResponse({ name: 'Active', enabled: true })
		mockUseTriggers.mockReturnValue({ data: [trigger], isLoading: false })
		render(<TriggersPage />)
		const link = screen.getByRole('link', { name: /Active/ })
		const dot = link.querySelector('span')
		expect(dot).toBeInTheDocument()
		expect(dot).toHaveClass('bg-success')
	})
})
