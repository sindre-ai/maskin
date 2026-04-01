import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockUseActors = vi.fn()
const mockUseWorkspaceSessions = vi.fn()

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

vi.mock('@/hooks/use-actors', () => ({
	useActors: (...args: unknown[]) => mockUseActors(...args),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: (...args: unknown[]) => mockUseWorkspaceSessions(...args),
}))

vi.mock('@/lib/agent-status', () => ({
	deriveAgentStatus: (_id: string, _map: Map<string, unknown>) => 'idle',
	getLatestSession: () => null,
	groupSessionsByAgent: () => new Map(),
}))

vi.mock('@/components/agents/agent-card', () => ({
	AgentCard: ({ agent, status }: { agent: { name: string }; status: string }) => (
		<div data-testid="agent-card">
			{agent.name} - {status}
		</div>
	),
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
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

import { Route } from '@/routes/_authed/$workspaceId/agents/index'

// @ts-expect-error — mock returns raw route options
const AgentsPage = Route.component as React.FC

describe('AgentsPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseWorkspaceSessions.mockReturnValue({ data: [] })
	})

	it('shows loading skeleton when actors are loading', () => {
		mockUseActors.mockReturnValue({ data: undefined, isLoading: true })
		render(<AgentsPage />)
		expect(screen.getAllByTestId('card-skeleton')).toHaveLength(2)
	})

	it('shows empty state when no agents exist', () => {
		mockUseActors.mockReturnValue({ data: [], isLoading: false })
		render(<AgentsPage />)
		expect(screen.getByText('No agents in this workspace')).toBeInTheDocument()
	})

	it('renders agent cards for agents only, not humans', () => {
		mockUseActors.mockReturnValue({
			data: [
				{ id: 'a1', name: 'Agent One', type: 'agent', email: null },
				{ id: 'a2', name: 'Human User', type: 'human', email: 'h@test.com' },
				{ id: 'a3', name: 'Agent Two', type: 'agent', email: null },
			],
			isLoading: false,
		})
		render(<AgentsPage />)
		const cards = screen.getAllByTestId('agent-card')
		expect(cards).toHaveLength(2)
		expect(screen.getByText(/Agent One/)).toBeInTheDocument()
		expect(screen.getByText(/Agent Two/)).toBeInTheDocument()
		expect(screen.queryByText(/Human User/)).not.toBeInTheDocument()
	})

	it('displays status filter tabs with counts', () => {
		mockUseActors.mockReturnValue({
			data: [
				{ id: 'a1', name: 'Agent One', type: 'agent', email: null },
				{ id: 'a2', name: 'Agent Two', type: 'agent', email: null },
			],
			isLoading: false,
		})
		render(<AgentsPage />)
		expect(screen.getByRole('button', { name: /All \(2\)/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Idle \(2\)/ })).toBeInTheDocument()
	})

	it('shows empty state when no agents match filter', async () => {
		mockUseActors.mockReturnValue({
			data: [{ id: 'a1', name: 'Agent One', type: 'agent', email: null }],
			isLoading: false,
		})
		const user = userEvent.setup()
		render(<AgentsPage />)
		await user.click(screen.getByRole('button', { name: /Failed/ }))
		expect(screen.queryByTestId('agent-card')).not.toBeInTheDocument()
	})
})
