import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockUseActor = vi.fn()
const mockUseWorkspaceMembers = vi.fn()
const mockUpdateActorMutate = vi.fn()
const mockUpdateRoleMutateAsync = vi.fn().mockResolvedValue({})
const mockRemoveMemberMutate = vi.fn()
const mockRemoveMemberReset = vi.fn()

vi.mock('@/hooks/use-actors', () => ({
	useActor: (...args: unknown[]) => mockUseActor(...args),
	useUpdateActor: () => ({ mutate: mockUpdateActorMutate, isPending: false }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: (...args: unknown[]) => mockUseWorkspaceMembers(...args),
	useUpdateWorkspaceMemberRole: () => ({
		mutateAsync: mockUpdateRoleMutateAsync,
		isPending: false,
	}),
	// The dialog also owns the remove-member action; without this the module
	// mock is missing an export the component imports and every test throws
	// before rendering.
	useRemoveWorkspaceMember: () => ({
		mutate: mockRemoveMemberMutate,
		reset: mockRemoveMemberReset,
		isPending: false,
		error: null,
	}),
}))

// The dialog reads `workspace.billingOwnerId` to decide whether the role Select
// is disabled. Default to a different actor so the Select stays enabled.
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: { id: 'ws-1', name: 'Test Workspace', billingOwnerId: 'someone-else' },
	}),
}))

vi.mock('@/components/shared/actor-avatar', () => ({
	ActorAvatar: ({ name }: { name: string }) => <div data-testid="avatar">{name}</div>,
}))

function renderDialog() {
	return render(
		<TestWrapper>
			<HumanDetailDialog actorId="a1" workspaceId="ws-1" open onOpenChange={vi.fn()} />
		</TestWrapper>,
	)
}

describe('HumanDetailDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseActor.mockReturnValue({
			data: {
				id: 'a1',
				name: 'Alice',
				email: 'alice@example.com',
				description: '',
				system_prompt: '',
			},
		})
		mockUseWorkspaceMembers.mockReturnValue({
			data: [{ actorId: 'a1', name: 'Alice', type: 'human', role: 'member', joinedAt: null }],
		})
	})

	it('renders the role Select showing the current membership role', () => {
		renderDialog()
		expect(screen.getByRole('combobox', { name: /Role for Alice/i })).toHaveTextContent('member')
	})

	it('calls updateRole with the new role when the user picks one', async () => {
		renderDialog()

		fireEvent.click(screen.getByRole('combobox', { name: /Role for Alice/i }))
		fireEvent.click(await screen.findByRole('option', { name: 'admin' }))

		await waitFor(() =>
			expect(mockUpdateRoleMutateAsync).toHaveBeenCalledWith({ actorId: 'a1', role: 'admin' }),
		)
	})

	it('hides the role Select when the actor is not a workspace member', () => {
		mockUseWorkspaceMembers.mockReturnValue({ data: [] })
		renderDialog()
		expect(screen.queryByRole('combobox', { name: /Role for/i })).not.toBeInTheDocument()
	})

	it('surfaces an error message when the role update fails', async () => {
		mockUpdateRoleMutateAsync.mockRejectedValueOnce(new Error('nope'))
		renderDialog()

		fireEvent.click(screen.getByRole('combobox', { name: /Role for Alice/i }))
		fireEvent.click(await screen.findByRole('option', { name: 'admin' }))

		expect(await screen.findByRole('alert')).toHaveTextContent('nope')
	})

	// Ownership moves through POST /{id}/transfer-ownership, which enforces the
	// plan's ownership cap. The backend body schema is z.enum(['admin','member']),
	// so offering `owner` here would be a guaranteed 400.
	it('does not offer owner as a selectable role', async () => {
		renderDialog()

		fireEvent.click(screen.getByRole('combobox', { name: /Role for Alice/i }))

		expect(await screen.findByRole('option', { name: 'admin' })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: 'member' })).toBeInTheDocument()
		expect(screen.queryByRole('option', { name: 'owner' })).not.toBeInTheDocument()
	})
})
