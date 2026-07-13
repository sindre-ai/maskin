import { StatusBadge } from '@/components/shared/status-badge'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('StatusBadge', () => {
	it('renders status text', () => {
		render(<StatusBadge status="active" />)
		expect(screen.getByText('active')).toBeInTheDocument()
	})

	it('replaces underscores with spaces in display', () => {
		render(<StatusBadge status="in_progress" />)
		expect(screen.getByText('in progress')).toBeInTheDocument()
	})

	it('renders as button when onClick provided', () => {
		render(<StatusBadge status="active" onClick={() => {}} />)
		expect(screen.getByRole('button')).toBeInTheDocument()
	})

	it('calls onClick when clicked', async () => {
		const user = userEvent.setup()
		const onClick = vi.fn()
		render(<StatusBadge status="active" onClick={onClick} />)

		await user.click(screen.getByRole('button'))
		expect(onClick).toHaveBeenCalledOnce()
	})

	it('calls onClick on Enter key', async () => {
		const user = userEvent.setup()
		const onClick = vi.fn()
		render(<StatusBadge status="active" onClick={onClick} />)

		screen.getByRole('button').focus()
		await user.keyboard('{Enter}')
		expect(onClick).toHaveBeenCalledOnce()
	})

	it('calls onClick on Space key', async () => {
		const user = userEvent.setup()
		const onClick = vi.fn()
		render(<StatusBadge status="active" onClick={onClick} />)

		screen.getByRole('button').focus()
		await user.keyboard('{ }')
		expect(onClick).toHaveBeenCalledOnce()
	})

	it('does not render button role when no onClick', () => {
		render(<StatusBadge status="active" />)
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
	})

	it('renders in_review as "in review"', () => {
		render(<StatusBadge status="in_review" />)
		expect(screen.getByText('in review')).toBeInTheDocument()
	})

	describe('variant="dot-word"', () => {
		it('renders a leading dot and the status word', () => {
			render(<StatusBadge status="active" variant="dot-word" />)
			expect(screen.getByText('active')).toBeInTheDocument()
			const dot = screen.getByTestId('status-dot')
			expect(dot).toBeInTheDocument()
			expect(dot).toHaveAttribute('aria-hidden', 'true')
		})

		it('carries the status text color class so the dot picks up bg-current', () => {
			const { container } = render(<StatusBadge status="in_progress" variant="dot-word" />)
			const pill = container.querySelector('[aria-label="Status in progress"]')
			expect(pill).not.toBeNull()
			expect(pill?.className).toContain('text-status-in_progress-text')
		})

		it('replaces underscores with spaces in dot-word label', () => {
			render(<StatusBadge status="in_review" variant="dot-word" />)
			expect(screen.getByText('in review')).toBeInTheDocument()
		})

		it('is not a Badge/outline pill — no bg-status-*-bg class', () => {
			const { container } = render(<StatusBadge status="active" variant="dot-word" />)
			const pill = container.querySelector('[aria-label="Status active"]')
			expect(pill?.className).not.toMatch(/bg-status-.*-bg/)
		})
	})
})
