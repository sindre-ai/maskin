import { SuggestChip } from '@/components/shared/suggest-chip'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('SuggestChip', () => {
	it('renders the suggestion text', () => {
		render(<SuggestChip label="Catch me up on billing" />)
		expect(screen.getByRole('button', { name: /Catch me up on billing/ })).toBeInTheDocument()
	})

	it('fires onSelect when clicked', async () => {
		const onSelect = vi.fn()
		render(<SuggestChip label="Draft Acme note" onSelect={onSelect} />)
		await userEvent.click(screen.getByRole('button'))
		expect(onSelect).toHaveBeenCalledTimes(1)
	})
})
