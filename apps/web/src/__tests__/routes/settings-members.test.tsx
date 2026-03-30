import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseWorkspaceMembers = vi.fn()

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

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: (...args: any[]) => mockUseWorkspaceMembers(...args),
	useAddWorkspaceMember: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('@/components/shared/actor-avatar', () => ({
	ActorAvatar: ({ name }: { name: string }) => <div data-testid="avatar">{name}</div>,
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

import { Route } from '@/routes/_authed/$workspaceId/settings/members'

const MembersPage = Route.component as React.FC

describe('MembersPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows loading skeleton when members are loading', () => {
		mockUseWorkspaceMembers.mockReturnValue({ data: undefined, isLoading: true })
		render(<MembersPage />)
		expect(screen.getByTestId('list-skeleton')).toBeInTheDocument()
	})

	it('shows empty state when no members', () => {
		mockUseWorkspaceMembers.mockReturnValue({ data: [], isLoading: false })
		render(<MembersPage />)
		expect(screen.getByText('No members')).toBeInTheDocument()
	})

	it('renders member list with names and roles', () => {
		mockUseWorkspaceMembers.mockReturnValue({
			data: [
				{ actorId: 'a1', name: 'Alice', type: 'human', role: 'admin', joinedAt: null },
				{ actorId: 'a2', name: 'Bot One', type: 'agent', role: 'member', joinedAt: null },
			],
			isLoading: false,
		})
		render(<MembersPage />)
		// Names appear in both avatar mock and member row, so use getAllByText
		expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1)
		expect(screen.getAllByText('Bot One').length).toBeGreaterThanOrEqual(1)
		expect(screen.getByText('admin')).toBeInTheDocument()
	})

	it('renders "Add member" button', () => {
		mockUseWorkspaceMembers.mockReturnValue({ data: [], isLoading: false })
		render(<MembersPage />)
		expect(screen.getByRole('button', { name: /Add member/ })).toBeInTheDocument()
	})
})
