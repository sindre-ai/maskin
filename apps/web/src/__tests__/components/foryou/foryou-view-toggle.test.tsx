import { ForYouViewToggle } from '@/components/foryou/foryou-view-toggle'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('ForYouViewToggle', () => {
	it('renders both toggle buttons', () => {
		render(<ForYouViewToggle value="card" onChange={() => {}} />)
		expect(screen.getByRole('button', { name: 'Card view' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'List view' })).toBeInTheDocument()
	})

	it('reflects the current value via aria-pressed', () => {
		const { rerender } = render(<ForYouViewToggle value="card" onChange={() => {}} />)
		expect(screen.getByRole('button', { name: 'Card view' })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
		expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute(
			'aria-pressed',
			'false',
		)

		rerender(<ForYouViewToggle value="list" onChange={() => {}} />)
		expect(screen.getByRole('button', { name: 'Card view' })).toHaveAttribute(
			'aria-pressed',
			'false',
		)
		expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
	})

	it('calls onChange with the clicked mode', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<ForYouViewToggle value="card" onChange={onChange} />)
		await user.click(screen.getByRole('button', { name: 'List view' }))
		expect(onChange).toHaveBeenCalledWith('list')

		onChange.mockClear()
		render(<ForYouViewToggle value="list" onChange={onChange} />)
		await user.click(screen.getAllByRole('button', { name: 'Card view' })[1])
		expect(onChange).toHaveBeenCalledWith('card')
	})

	it('wraps the buttons in a role="group" with an accessible name', () => {
		const { container } = render(<ForYouViewToggle value="card" onChange={() => {}} />)
		const group = container.querySelector('[role="group"]')
		expect(group).toHaveAttribute('aria-label', 'For You view mode')
	})
})
