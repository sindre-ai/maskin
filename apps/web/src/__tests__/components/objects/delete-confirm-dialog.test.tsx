import { DeleteConfirmDialog } from '@/components/objects/object-document'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

describe('DeleteConfirmDialog', () => {
	// The inline "Delete this bet? / Confirm / Cancel" cluster used to live in
	// the fixed-height (h-11) page header, where it collided with other header
	// actions at 375px. Moving it into a Dialog confirm keeps the header tidy
	// on mobile and gives the destructive action a thumb-friendly target.

	it('renders the confirm question and destructive action when open', () => {
		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="bet"
				onConfirm={vi.fn()}
				isPending={false}
			/>,
		)
		expect(screen.getByRole('heading', { name: /delete this bet\?/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
	})

	it('renders nothing when closed', () => {
		render(
			<DeleteConfirmDialog
				open={false}
				onOpenChange={vi.fn()}
				objectType="bet"
				onConfirm={vi.fn()}
				isPending={false}
			/>,
		)
		expect(screen.queryByRole('heading', { name: /delete this bet\?/i })).not.toBeInTheDocument()
	})

	it('calls onConfirm when the destructive action is clicked', async () => {
		const user = userEvent.setup()
		const onConfirm = vi.fn()
		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="task"
				onConfirm={onConfirm}
				isPending={false}
			/>,
		)
		await user.click(screen.getByRole('button', { name: /^delete$/i }))
		expect(onConfirm).toHaveBeenCalledTimes(1)
	})

	it('shows a pending label and disables both buttons while deleting', () => {
		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="insight"
				onConfirm={vi.fn()}
				isPending
			/>,
		)
		expect(screen.getByRole('button', { name: /deleting/i })).toBeDisabled()
		expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
	})
})
