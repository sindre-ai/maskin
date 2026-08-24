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
	PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
		<h1>
			{title}
			{subtitle ? <span>{subtitle}</span> : null}
		</h1>
	),
}))
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))
vi.mock('@/components/shared/route-error', () => ({ RouteError: () => <div>Error</div> }))
vi.mock('@/components/shared/empty-state', () => ({
	EmptyState: ({ title, action }: { title: string; action?: React.ReactNode }) => (
		<div>
			{title}
			{action}
		</div>
	),
}))
vi.mock('@/components/shared/loading-skeleton', () => ({
	ListSkeleton: () => <div data-testid="list-skeleton" />,
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

import { NewDesignProvider } from '@/lib/new-design-context'
import { Route } from '@/routes/_authed/$workspaceId/agents/index'

const RouteOptions = Route as unknown as { component: React.FC }
const AgentsPage = RouteOptions.component

// The v2 index lives behind the `new-design` boundary in this route, so the
// provider has to be on for these specs to exercise it.
function mount() {
	return render(
		<NewDesignProvider value={true}>
			<AgentsPage />
		</NewDesignProvider>,
	)
}

beforeEach(() => {
	viewCapture.__agentsViewCapture.lastProps = null
	useActorsMock.mockReset()
	useWorkspaceSessionsMock.mockReset()
	useWorkspaceSessionsMock.mockReturnValue({ data: [] })
})

describe('AgentsPage', () => {
	it('shows a row-shaped loading skeleton while actors are loading', () => {
		useActorsMock.mockReturnValue({ data: undefined, isLoading: true })
		mount()
		// The loaded surface is a row list, so the skeleton must preview rows.
		expect(screen.getByTestId('list-skeleton')).toBeInTheDocument()
		expect(screen.queryByTestId('agents-index-view')).not.toBeInTheDocument()
	})

	it('shows the zero state with a create action when the workspace has no agents', () => {
		useActorsMock.mockReturnValue({
			data: [buildActorListItem({ type: 'human' })],
			isLoading: false,
		})
		mount()
		expect(screen.getByText('Nobody on this team yet.')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Create an agent' })).toBeInTheDocument()
		expect(screen.queryByTestId('agents-index-view')).not.toBeInTheDocument()
	})

	it('publishes the title and the agent count to the nav row', () => {
		useActorsMock.mockReturnValue({
			data: [
				buildActorListItem({ id: 'agent-a', type: 'agent' }),
				buildActorListItem({ id: 'agent-b', type: 'agent' }),
			],
			isLoading: false,
		})
		mount()
		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Agents')
		expect(screen.getByText('2 agents · each owns one outcome')).toBeInTheDocument()
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
