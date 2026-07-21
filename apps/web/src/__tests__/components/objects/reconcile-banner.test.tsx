import { ReconcileBanner } from '@/components/objects/reconcile-banner'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('ReconcileBanner', () => {
	it('renders nothing when idle', () => {
		const { container } = render(
			<ReconcileBanner
				status="idle"
				onReview={vi.fn()}
				onKeepMine={vi.fn()}
				onTakeTheirs={vi.fn()}
			/>,
		)
		expect(container.firstChild).toBeNull()
	})

	it('renders the message and three actions when a conflict is active', () => {
		render(
			<ReconcileBanner
				status="conflict"
				onReview={vi.fn()}
				onKeepMine={vi.fn()}
				onTakeTheirs={vi.fn()}
			/>,
		)
		expect(screen.getByText(/content changed underneath you/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /keep mine/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /take theirs/i })).toBeInTheDocument()
	})

	it('has no bare dismiss X — the only paths out are the three actions', () => {
		render(
			<ReconcileBanner
				status="conflict"
				onReview={vi.fn()}
				onKeepMine={vi.fn()}
				onTakeTheirs={vi.fn()}
			/>,
		)
		expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument()
	})

	it('fires the right handler for each action', async () => {
		const user = userEvent.setup()
		const onReview = vi.fn()
		const onKeepMine = vi.fn()
		const onTakeTheirs = vi.fn()
		render(
			<ReconcileBanner
				status="conflict"
				onReview={onReview}
				onKeepMine={onKeepMine}
				onTakeTheirs={onTakeTheirs}
			/>,
		)
		await user.click(screen.getByRole('button', { name: /review/i }))
		await user.click(screen.getByRole('button', { name: /keep mine/i }))
		await user.click(screen.getByRole('button', { name: /take theirs/i }))
		expect(onReview).toHaveBeenCalledTimes(1)
		expect(onKeepMine).toHaveBeenCalledTimes(1)
		expect(onTakeTheirs).toHaveBeenCalledTimes(1)
	})

	it('disables all three actions while retrying', () => {
		render(
			<ReconcileBanner
				status="retrying"
				onReview={vi.fn()}
				onKeepMine={vi.fn()}
				onTakeTheirs={vi.fn()}
			/>,
		)
		for (const btn of screen.getAllByRole('button')) {
			expect(btn).toBeDisabled()
		}
	})
})
