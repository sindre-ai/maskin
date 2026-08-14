import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockUseActors = vi.fn()
const mockUseWorkspaceSessions = vi.fn()
const mockRunMutate = vi.fn()
const mockPauseMutate = vi.fn()

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}))

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
	useAgentRun: () => ({
		mutate: mockRunMutate,
		isPending: false,
		variables: undefined,
	}),
	useAgentPause: () => ({
		mutate: mockPauseMutate,
		isPending: false,
		variables: undefined,
	}),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: (...args: unknown[]) => mockUseWorkspaceSessions(...args),
}))

vi.mock('@/lib/agent-status', () => ({
	deriveAgentStatus: (_id: string, _map: Map<string, unknown>) => 'idle',
	getLatestSession: () => null,
	groupSessionsByAgent: () => new Map(),
}))

vi.mock('@/components/agents/agent-portrait-card', async () => {
	const actual = await vi.importActual<typeof import('@/components/agents/agent-portrait-card')>(
		'@/components/agents/agent-portrait-card',
	)
	return {
		...actual,
		AgentPortraitCard: ({
			agent,
			status,
			onRun,
			onPause,
		}: {
			agent: { id: string; name: string }
			status: string
			onRun: () => void
			onPause: () => void
		}) => (
			<div data-testid="agent-portrait-card">
				<span>
					{agent.name} - {status}
				</span>
				<button type="button" onClick={onRun}>
					Run-{agent.id}
				</button>
				<button type="button" onClick={onPause}>
					Pause-{agent.id}
				</button>
			</div>
		),
	}
})

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

vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))

import { Route } from '@/routes/_authed/$workspaceId/agents/index'

const AgentsPage = (Route as unknown as { component: React.FC }).component

describe('AgentsPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseWorkspaceSessions.mockReturnValue({ data: [] })
	})

	it('shows loading skeleton when actors are loading', () => {
		mockUseActors.mockReturnValue({ data: undefined, isLoading: true })
		render(<AgentsPage />)
		expect(screen.getAllByTestId('card-skeleton')).toHaveLength(3)
	})

	it('shows empty state when no agents exist', () => {
		mockUseActors.mockReturnValue({ data: [], isLoading: false })
		render(<AgentsPage />)
		expect(screen.getByText('No agents in this workspace')).toBeInTheDocument()
	})

	it('renders portrait cards for agents only, not humans', () => {
		mockUseActors.mockReturnValue({
			data: [
				{ id: 'a1', name: 'Agent One', type: 'agent', email: null },
				{ id: 'a2', name: 'Human User', type: 'human', email: 'h@test.com' },
				{ id: 'a3', name: 'Agent Two', type: 'agent', email: null },
			],
			isLoading: false,
		})
		render(<AgentsPage />)
		const cards = screen.getAllByTestId('agent-portrait-card')
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
		expect(screen.queryByTestId('agent-portrait-card')).not.toBeInTheDocument()
	})

	it('wires Run handler to useAgentRun', async () => {
		mockUseActors.mockReturnValue({
			data: [{ id: 'a1', name: 'Agent One', type: 'agent', email: null }],
			isLoading: false,
		})
		const user = userEvent.setup()
		render(<AgentsPage />)
		await user.click(screen.getByRole('button', { name: /Run-a1/ }))
		expect(mockRunMutate).toHaveBeenCalledWith(
			{ id: 'a1' },
			expect.objectContaining({ onError: expect.any(Function) }),
		)
	})

	it('wires Pause handler to useAgentPause', async () => {
		mockUseActors.mockReturnValue({
			data: [{ id: 'a1', name: 'Agent One', type: 'agent', email: null }],
			isLoading: false,
		})
		const user = userEvent.setup()
		render(<AgentsPage />)
		await user.click(screen.getByRole('button', { name: /Pause-a1/ }))
		expect(mockPauseMutate).toHaveBeenCalledWith(
			'a1',
			expect.objectContaining({ onError: expect.any(Function) }),
		)
	})

	it('toasts agent name when run fails', async () => {
		const { toast } = await import('sonner')
		mockUseActors.mockReturnValue({
			data: [{ id: 'a1', name: 'Agent One', type: 'agent', email: null }],
			isLoading: false,
		})
		mockRunMutate.mockImplementation((_vars: unknown, opts?: { onError?: () => void }) => {
			opts?.onError?.()
		})
		const user = userEvent.setup()
		render(<AgentsPage />)
		await user.click(screen.getByRole('button', { name: /Run-a1/ }))
		expect(toast.error).toHaveBeenCalledWith("Couldn't start Agent One")
	})

	it('toasts agent name when pause fails', async () => {
		const { toast } = await import('sonner')
		mockUseActors.mockReturnValue({
			data: [{ id: 'a1', name: 'Agent One', type: 'agent', email: null }],
			isLoading: false,
		})
		mockPauseMutate.mockImplementation((_id: unknown, opts?: { onError?: () => void }) => {
			opts?.onError?.()
		})
		const user = userEvent.setup()
		render(<AgentsPage />)
		await user.click(screen.getByRole('button', { name: /Pause-a1/ }))
		expect(toast.error).toHaveBeenCalledWith("Couldn't pause Agent One")
	})

	it('counts a running agent under the Working tab', () => {
		mockUseActors.mockReturnValue({
			data: [
				{ id: 'a1', name: 'Agent One', type: 'agent', email: null, agentState: 'running' },
				{ id: 'a2', name: 'Agent Two', type: 'agent', email: null, agentState: 'idle' },
			],
			isLoading: false,
		})
		render(<AgentsPage />)
		expect(screen.getByRole('button', { name: /Working \(1\)/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Idle \(1\)/ })).toBeInTheDocument()
	})

	it('counts a paused agent under the Idle tab (no Paused tab)', () => {
		mockUseActors.mockReturnValue({
			data: [{ id: 'a1', name: 'Agent One', type: 'agent', email: null, agentState: 'paused' }],
			isLoading: false,
		})
		render(<AgentsPage />)
		expect(screen.getByRole('button', { name: /Idle \(1\)/ })).toBeInTheDocument()
	})
})
