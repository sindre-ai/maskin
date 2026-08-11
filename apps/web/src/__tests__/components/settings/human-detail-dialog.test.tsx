import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockUpdateMutate = vi.fn()
const updatePending = { value: false }
const mockUseActor = vi.fn()

vi.mock('@/hooks/use-actors', () => ({
	useActor: (id: string) => mockUseActor(id),
	useUpdateActor: () => ({ mutate: mockUpdateMutate, isPending: updatePending.value }),
}))

describe('HumanDetailDialog', () => {
	beforeEach(() => {
		mockUpdateMutate.mockReset()
		mockUseActor.mockReset()
		updatePending.value = false
	})

	it('renders the dialog with the actor name', () => {
		const actor = buildActorResponse({
			id: 'human-1',
			name: 'Magnus',
			type: 'human',
			system_prompt: 'Loves shipping things',
		})
		mockUseActor.mockReturnValue({ data: actor })

		render(
			<TestWrapper>
				<HumanDetailDialog
					actorId="human-1"
					workspaceId="ws-1"
					open={true}
					onOpenChange={() => {}}
				/>
			</TestWrapper>,
		)

		expect(screen.getAllByText('Magnus').length).toBeGreaterThan(0)
		expect(screen.getByLabelText('System prompt')).toHaveValue('Loves shipping things')
	})

	it('saves edits to system_prompt via useUpdateActor.mutate', async () => {
		const user = userEvent.setup()
		const actor = buildActorResponse({
			id: 'human-1',
			name: 'Magnus',
			type: 'human',
			system_prompt: 'Original prompt',
		})
		mockUseActor.mockReturnValue({ data: actor })

		render(
			<TestWrapper>
				<HumanDetailDialog
					actorId="human-1"
					workspaceId="ws-1"
					open={true}
					onOpenChange={() => {}}
				/>
			</TestWrapper>,
		)

		const textarea = screen.getByLabelText('System prompt')
		await user.clear(textarea)
		await user.type(textarea, 'Updated prompt')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => {
			expect(mockUpdateMutate).toHaveBeenCalledTimes(1)
		})
		const [args] = mockUpdateMutate.mock.calls[0]
		expect(args).toEqual({ id: 'human-1', data: { system_prompt: 'Updated prompt' } })
	})

	it('closes without calling mutate when no fields changed', async () => {
		const user = userEvent.setup()
		const onOpenChange = vi.fn()
		const actor = buildActorResponse({
			id: 'human-1',
			name: 'Magnus',
			type: 'human',
			system_prompt: 'Same prompt',
		})
		mockUseActor.mockReturnValue({ data: actor })

		render(
			<TestWrapper>
				<HumanDetailDialog
					actorId="human-1"
					workspaceId="ws-1"
					open={true}
					onOpenChange={onOpenChange}
				/>
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(mockUpdateMutate).not.toHaveBeenCalled()
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('renders nothing when actorId is null', () => {
		mockUseActor.mockReturnValue({ data: undefined })

		const { container } = render(
			<TestWrapper>
				<HumanDetailDialog actorId={null} workspaceId="ws-1" open={true} onOpenChange={() => {}} />
			</TestWrapper>,
		)

		expect(container).toBeEmptyDOMElement()
	})

	it('disables Save while the mutation is pending', () => {
		updatePending.value = true
		mockUseActor.mockReturnValue({
			data: buildActorResponse({ id: 'human-1', type: 'human' }),
		})

		render(
			<TestWrapper>
				<HumanDetailDialog
					actorId="human-1"
					workspaceId="ws-1"
					open={true}
					onOpenChange={() => {}}
				/>
			</TestWrapper>,
		)

		expect(screen.getByRole('button', { name: /Saving|Save/ })).toBeDisabled()
	})
})
