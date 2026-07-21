import { ReconcileTakeTheirsConfirm } from '@/components/objects/reconcile-take-theirs-confirm'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('ReconcileTakeTheirsConfirm', () => {
	it('renders the destructive confirm copy when open', () => {
		render(<ReconcileTakeTheirsConfirm open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
		expect(screen.getByText(/discard your edits/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /discard and take theirs/i })).toBeInTheDocument()
	})

	it('confirm fires the callback; cancel closes without confirming', async () => {
		const user = userEvent.setup()
		const onConfirm = vi.fn()
		const onOpenChange = vi.fn()
		render(
			<ReconcileTakeTheirsConfirm open={true} onOpenChange={onOpenChange} onConfirm={onConfirm} />,
		)
		await user.click(screen.getByRole('button', { name: /^cancel$/i }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(onConfirm).not.toHaveBeenCalled()

		await user.click(screen.getByRole('button', { name: /discard and take theirs/i }))
		expect(onConfirm).toHaveBeenCalledTimes(1)
	})
})
