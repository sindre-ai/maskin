import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockUseActor = vi.fn()
const mockUseWorkspaceMembers = vi.fn()
const mockUpdateActorMutate = vi.fn()
const mockUpdateRoleMutateAsync = vi.fn().mockResolvedValue({})

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
		fireEvent.click(await screen.findByRole('option', { name: 'owner' }))

		expect(await screen.findByRole('alert')).toHaveTextContent('nope')
	})
})
