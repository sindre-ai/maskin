import { PageSearchInput } from '@/components/shared/page-search-input'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('PageSearchInput Esc', () => {
	it('clears the text and leaves the wide field', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<PageSearchInput value="" onChange={onChange} label="Search agents" />)

		const field = screen.getByRole('searchbox', { name: 'Search agents' })
		await user.click(field)
		await user.type(field, 'abc')
		expect(onChange).toHaveBeenLastCalledWith('abc')

		await user.keyboard('{Escape}')
		expect(onChange).toHaveBeenLastCalledWith('')
		expect(field).toHaveValue('')
		expect(field).not.toHaveFocus()
	})

	it('clears the text and closes the narrow takeover field', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<PageSearchInput value="" onChange={onChange} label="Search agents" />)

		await user.click(screen.getByRole('button', { name: 'Search agents' }))
		const [, narrow] = screen.getAllByRole('searchbox', { name: 'Search agents' })
		await user.type(narrow, 'abc')
		expect(onChange).toHaveBeenLastCalledWith('abc')

		await user.keyboard('{Escape}')
		expect(onChange).toHaveBeenLastCalledWith('')
		expect(screen.queryByRole('button', { name: 'Close search' })).not.toBeInTheDocument()
		for (const box of screen.getAllByRole('searchbox', { name: 'Search agents' })) {
			expect(box).toHaveValue('')
		}
	})
})
