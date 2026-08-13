import { LoopPatchCard } from '@/components/loops/loop-patch-card'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const onApply = vi.fn()
const onDismiss = vi.fn()

beforeEach(() => {
	onApply.mockClear()
	onDismiss.mockClear()
})

describe('LoopPatchCard', () => {
	const patch = {
		title: 'Update loop name',
		rows: [
			{ label: 'Name', before: 'Old name', after: 'New name' },
			{ label: 'Status', before: 'Running', after: 'Paused' },
		],
		note: 'Nothing moves until you say so.',
	}

	it('renders the proposed edit as before/after rows with both actions', () => {
		render(<LoopPatchCard patch={patch} onApply={onApply} onDismiss={onDismiss} />)

		expect(screen.getByText('Proposed edit')).toBeInTheDocument()
		expect(screen.getByText('Update loop name')).toBeInTheDocument()

		expect(screen.getByText('Old name')).toBeInTheDocument()
		expect(screen.getByText('New name')).toBeInTheDocument()
		expect(screen.getByText('Running')).toBeInTheDocument()
		expect(screen.getByText('Paused')).toBeInTheDocument()

		expect(screen.getByRole('button', { name: 'Make the change' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Leave it' })).toBeInTheDocument()
		expect(screen.getByText('nothing moves until you say so')).toBeInTheDocument()
	})

	it('renders a note when provided', () => {
		render(<LoopPatchCard patch={patch} onApply={onApply} onDismiss={onDismiss} />)
		expect(screen.getByText(patch.note)).toBeInTheDocument()
	})

	it('"Leave it" dismisses the proposal without applying any change', async () => {
		const user = userEvent.setup()
		render(<LoopPatchCard patch={patch} onApply={onApply} onDismiss={onDismiss} />)

		await user.click(screen.getByRole('button', { name: 'Leave it' }))

		expect(onDismiss).toHaveBeenCalledTimes(1)
		expect(onApply).not.toHaveBeenCalled()
	})

	it('"Make the change" applies the edit', async () => {
		const user = userEvent.setup()
		render(<LoopPatchCard patch={patch} onApply={onApply} onDismiss={onDismiss} />)

		await user.click(screen.getByRole('button', { name: 'Make the change' }))

		expect(onApply).toHaveBeenCalledTimes(1)
		expect(onDismiss).not.toHaveBeenCalled()
	})

	it('disables both actions while an apply is in flight', () => {
		render(<LoopPatchCard patch={patch} isApplying onApply={onApply} onDismiss={onDismiss} />)

		expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Leave it' })).toBeDisabled()
	})
})
