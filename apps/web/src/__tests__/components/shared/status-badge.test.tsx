import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StatusBadge } from '@/components/shared/status-badge'

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
})
