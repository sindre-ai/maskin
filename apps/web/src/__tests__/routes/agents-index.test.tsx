import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorListItem, buildSessionResponse } from '../factories'

const { useActorsMock, useWorkspaceSessionsMock } = vi.hoisted(() => ({
	useActorsMock: vi.fn(),
	useWorkspaceSessionsMock: vi.fn(),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { id: 'ws-1' } }),
}))

vi.mock('@/hooks/use-actors', () => ({ useActors: (wsId?: string) => useActorsMock(wsId) }))
vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: (wsId?: string) => useWorkspaceSessionsMock(wsId),
}))
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))
vi.mock('@/components/shared/route-error', () => ({ RouteError: () => <div>Error</div> }))
vi.mock('@/components/shared/empty-state', () => ({
	EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock('@/components/shared/loading-skeleton', () => ({
	CardSkeleton: () => <div data-testid="card-skeleton" />,
}))

type ViewCapture = { lastProps: Record<string, unknown> | null }
const viewCapture = globalThis as unknown as { __agentsViewCapture: ViewCapture }
viewCapture.__agentsViewCapture = { lastProps: null }
vi.mock('@/components/agents/agents-index-view', () => ({
	AgentsIndexView: (props: Record<string, unknown>) => {
		;(globalThis as unknown as { __agentsViewCapture: ViewCapture }).__agentsViewCapture.lastProps =
			props
		return <div data-testid="agents-index-view" />
	},
}))

import { Route } from '@/routes/_authed/$workspaceId/agents/index'

const RouteOptions = Route as unknown as { component: React.FC }
const AgentsPage = RouteOptions.component

function mount() {
	return render(<AgentsPage />)
}

beforeEach(() => {
	viewCapture.__agentsViewCapture.lastProps = null
	useActorsMock.mockReset()
	useWorkspaceSessionsMock.mockReset()
	useWorkspaceSessionsMock.mockReturnValue({ data: [] })
})

describe('AgentsPage', () => {
	it('shows loading skeletons while actors are loading', () => {
		useActorsMock.mockReturnValue({ data: undefined, isLoading: true })
		mount()
		expect(screen.getAllByTestId('card-skeleton')).toHaveLength(3)
		expect(screen.queryByTestId('agents-index-view')).not.toBeInTheDocument()
	})

	it('shows an empty state when the workspace has no agents', () => {
		useActorsMock.mockReturnValue({
			data: [buildActorListItem({ type: 'human' })],
			isLoading: false,
		})
		mount()
		expect(screen.getByText('No agents in this workspace')).toBeInTheDocument()
		expect(screen.queryByTestId('agents-index-view')).not.toBeInTheDocument()
	})

	it('passes only agent-typed actors and their sessions to the index view', () => {
		const agentA = buildActorListItem({ id: 'agent-a', name: 'Alice', type: 'agent' })
		const agentB = buildActorListItem({ id: 'agent-b', name: 'Bob', type: 'agent' })
		const human = buildActorListItem({ id: 'human-1', name: 'Hana', type: 'human' })
		const sessions = [buildSessionResponse({ id: 's-1', actorId: 'agent-a' })]
		useActorsMock.mockReturnValue({ data: [agentA, human, agentB], isLoading: false })
		useWorkspaceSessionsMock.mockReturnValue({ data: sessions })
		mount()
		const props = viewCapture.__agentsViewCapture.lastProps
		expect(props).not.toBeNull()
		const agents = (props?.agents as { id: string }[]) ?? []
		expect(agents.map((a) => a.id).sort()).toEqual(['agent-a', 'agent-b'])
		expect(props?.workspaceId).toBe('ws-1')
		expect(props?.sessions).toEqual(sessions)
	})
})
