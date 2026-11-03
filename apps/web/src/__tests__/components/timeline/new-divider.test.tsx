import { NewDivider } from '@/components/timeline/new-divider'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('NewDivider', () => {
	it('renders the SPEC copy verbatim with a pluralised item count', () => {
		render(<NewDivider count={3} onMarkRead={() => {}} />)
		expect(screen.getByText('New — 3 items')).toBeInTheDocument()
	})

	it('renders "item" (singular) when the count is 1', () => {
		render(<NewDivider count={1} onMarkRead={() => {}} />)
		expect(screen.getByText('New — 1 item')).toBeInTheDocument()
	})

	it('exposes an aria-label naming the unread count and is focusable', () => {
		render(<NewDivider count={7} onMarkRead={() => {}} />)
		const separator = screen.getByRole('separator', { name: '7 unread items below' })
		// Focusable so a screen-reader user can jump to it and step into the
		// first unread comment below.
		expect(separator).toHaveAttribute('tabindex', '0')
	})

	it('invokes onMarkRead when the ✓ Mark all read button is clicked', async () => {
		const onMarkRead = vi.fn()
		const user = userEvent.setup()
		render(<NewDivider count={2} onMarkRead={onMarkRead} />)
		await user.click(screen.getByRole('button', { name: /Mark all read/ }))
		expect(onMarkRead).toHaveBeenCalledTimes(1)
	})
})
