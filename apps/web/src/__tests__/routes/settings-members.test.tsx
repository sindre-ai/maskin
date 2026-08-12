import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseWorkspaceMembers = vi.fn()
const mockUpdateRoleMutateAsync = vi.fn().mockResolvedValue({})
const mockRemoveMutateAsync = vi.fn().mockResolvedValue({ removed: true })
const mockAddMutateAsync = vi.fn().mockResolvedValue({ added: true })

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

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: (...args: unknown[]) => mockUseWorkspaceMembers(...args),
	useAddWorkspaceMember: () => ({ mutateAsync: mockAddMutateAsync, isPending: false }),
	useUpdateWorkspaceMemberRole: () => ({
		mutateAsync: mockUpdateRoleMutateAsync,
		isPending: false,
	}),
	useRemoveWorkspaceMember: () => ({ mutateAsync: mockRemoveMutateAsync, isPending: false }),
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

vi.mock('@/components/settings/human-detail-dialog', () => ({
	HumanDetailDialog: () => <div data-testid="human-detail-dialog" />,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/members'

const MembersPage = (Route as unknown as { component: React.FC }).component

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

	it('renders member table with names and roles', () => {
		mockUseWorkspaceMembers.mockReturnValue({
			data: [
				{ actorId: 'a1', name: 'Alice', type: 'human', role: 'admin', joinedAt: null },
				{ actorId: 'a2', name: 'Bot One', type: 'agent', role: 'member', joinedAt: null },
			],
			isLoading: false,
		})
		render(<MembersPage />)
		expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1)
		expect(screen.getAllByText('Bot One').length).toBeGreaterThanOrEqual(1)
		expect(screen.getByRole('combobox', { name: /Role for Alice/i })).toHaveTextContent('admin')
		expect(screen.getByRole('combobox', { name: /Role for Bot One/i })).toHaveTextContent('member')
	})

	it('renders an "Add member" trigger and a remove action per row', () => {
		mockUseWorkspaceMembers.mockReturnValue({
			data: [{ actorId: 'a1', name: 'Alice', type: 'human', role: 'member', joinedAt: null }],
			isLoading: false,
		})
		render(<MembersPage />)
		expect(screen.getByRole('button', { name: /Add member/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Remove Alice/ })).toBeInTheDocument()
	})

	it('opens confirmation and calls remove mutation when the user confirms', async () => {
		mockUseWorkspaceMembers.mockReturnValue({
			data: [{ actorId: 'a1', name: 'Alice', type: 'human', role: 'member', joinedAt: null }],
			isLoading: false,
		})
		render(<MembersPage />)

		fireEvent.click(screen.getByRole('button', { name: /Remove Alice/ }))

		const dialog = await screen.findByRole('dialog')
		expect(within(dialog).getByText(/Remove Alice from this workspace/)).toBeInTheDocument()

		fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
		await waitFor(() => expect(mockRemoveMutateAsync).toHaveBeenCalledWith('a1'))
	})
})
