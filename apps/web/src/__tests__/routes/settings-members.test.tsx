import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseWorkspaceMembers = vi.fn()
const mockUpdateRoleMutateAsync = vi.fn().mockResolvedValue({})
const mockRemoveMutateAsync = vi.fn().mockResolvedValue({ removed: true })
const mockUseWorkspaceInvites = vi.fn()
const mockResendMutateAsync = vi.fn().mockResolvedValue({})
const mockRevokeMutateAsync = vi.fn().mockResolvedValue({ revoked: true })

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useNavigate: () => mockNavigate,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { name: 'Værksted' } }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: (...args: unknown[]) => mockUseWorkspaceMembers(...args),
	useUpdateWorkspaceMemberRole: () => ({
		mutateAsync: mockUpdateRoleMutateAsync,
		isPending: false,
	}),
	useRemoveWorkspaceMember: () => ({ mutateAsync: mockRemoveMutateAsync, isPending: false }),
}))

vi.mock('@/hooks/use-invites', () => ({
	useWorkspaceInvites: (...args: unknown[]) => mockUseWorkspaceInvites(...args),
	useResendInvite: () => ({ mutateAsync: mockResendMutateAsync, isPending: false }),
	useRevokeInvite: () => ({ mutateAsync: mockRevokeMutateAsync, isPending: false }),
}))

vi.mock('@/components/settings/invite-member-dialog', () => ({
	InviteMemberDialog: ({ open }: { open: boolean }) => (open ? <p>Invite member dialog</p> : null),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

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
		mockUseWorkspaceInvites.mockReturnValue({ data: [] })
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

	it('renders the member count line beside the inline Members header', () => {
		mockUseWorkspaceMembers.mockReturnValue({
			data: [
				{ actorId: 'a1', name: 'Alice', type: 'human', role: 'admin', joinedAt: null },
				{ actorId: 'a2', name: 'Bot One', type: 'agent', role: 'member', joinedAt: null },
			],
			isLoading: false,
		})
		render(<MembersPage />)
		expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument()
		expect(screen.getByText('2 people & agents')).toBeInTheDocument()
	})

	it('hides connected integrations (system members) from the list and the count', () => {
		mockUseWorkspaceMembers.mockReturnValue({
			data: [
				{ actorId: 'a1', name: 'Alice', type: 'human', role: 'admin', joinedAt: null },
				{ actorId: 'a2', name: 'Bot One', type: 'agent', role: 'member', joinedAt: null },
				{ actorId: 'a3', name: 'GitHub', type: 'system', role: 'system', joinedAt: null },
			],
			isLoading: false,
		})
		render(<MembersPage />)
		expect(screen.queryByText('GitHub')).not.toBeInTheDocument()
		expect(screen.getByText('2 people & agents')).toBeInTheDocument()
	})

	it('navigates to agent detail when an agent row is clicked', () => {
		mockUseWorkspaceMembers.mockReturnValue({
			data: [{ actorId: 'a2', name: 'Bot One', type: 'agent', role: 'member', joinedAt: null }],
			isLoading: false,
		})
		render(<MembersPage />)

		fireEvent.click(screen.getAllByText('Bot One')[1])

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/agents/$agentId',
			params: { workspaceId: 'ws-1', agentId: 'a2' },
		})
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

	it('opens the email invite dialog from the Add member menu and no longer asks for an actor id', async () => {
		mockUseWorkspaceMembers.mockReturnValue({
			data: [{ actorId: 'a1', name: 'Alice', type: 'human', role: 'member', joinedAt: null }],
			isLoading: false,
		})
		const user = userEvent.setup()
		render(<MembersPage />)

		await user.click(screen.getByRole('button', { name: /Add member/ }))
		await user.click(await screen.findByRole('menuitem', { name: /Invite member/ }))

		expect(await screen.findByText('Invite member dialog')).toBeInTheDocument()
		expect(screen.queryByPlaceholderText(/Actor ID/i)).not.toBeInTheDocument()
	})

	describe('pending invites', () => {
		const members = [{ actorId: 'a1', name: 'Alice', type: 'human', role: 'owner', joinedAt: null }]
		const invite = {
			id: 'inv-1',
			email: 'ada@example.com',
			role: 'member',
			expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
			invitedByActorId: 'a1',
			invitedByName: 'Alice',
			createdAt: new Date().toISOString(),
		}

		it('lists pending invites below the members with a role and the expiry once under 24h', () => {
			mockUseWorkspaceMembers.mockReturnValue({ data: members, isLoading: false })
			mockUseWorkspaceInvites.mockReturnValue({ data: [invite] })
			render(<MembersPage />)

			expect(screen.getByText('Pending — 1')).toBeInTheDocument()
			expect(screen.getByText('ada@example.com')).toBeInTheDocument()
			expect(screen.getByText('Member')).toBeInTheDocument()
			expect(screen.getByText(/expires in 3h|expires in 4h/)).toBeInTheDocument()
		})

		it('omits the pending section when there are no pending invites', () => {
			mockUseWorkspaceMembers.mockReturnValue({ data: members, isLoading: false })
			render(<MembersPage />)
			expect(screen.queryByText(/^Pending/)).not.toBeInTheDocument()
		})

		it('hides the expiry countdown while more than 24h remain', () => {
			mockUseWorkspaceMembers.mockReturnValue({ data: members, isLoading: false })
			mockUseWorkspaceInvites.mockReturnValue({
				data: [
					{ ...invite, expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() },
				],
			})
			render(<MembersPage />)
			expect(screen.queryByText(/expires in/)).not.toBeInTheDocument()
		})

		it('resends through the resend mutation', async () => {
			mockUseWorkspaceMembers.mockReturnValue({ data: members, isLoading: false })
			mockUseWorkspaceInvites.mockReturnValue({ data: [invite] })
			render(<MembersPage />)

			fireEvent.click(screen.getByRole('button', { name: /Resend invite to ada@example.com/ }))

			await waitFor(() => expect(mockResendMutateAsync).toHaveBeenCalledWith('inv-1'))
		})

		it('confirms before revoking, then calls the revoke mutation', async () => {
			mockUseWorkspaceMembers.mockReturnValue({ data: members, isLoading: false })
			mockUseWorkspaceInvites.mockReturnValue({ data: [invite] })
			render(<MembersPage />)

			fireEvent.click(screen.getByRole('button', { name: /Revoke invite to ada@example.com/ }))
			const dialog = await screen.findByRole('dialog')
			expect(within(dialog).getByText('Revoke this invite?')).toBeInTheDocument()
			expect(mockRevokeMutateAsync).not.toHaveBeenCalled()

			fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
			await waitFor(() => expect(mockRevokeMutateAsync).toHaveBeenCalledWith('inv-1'))
		})
	})
})
