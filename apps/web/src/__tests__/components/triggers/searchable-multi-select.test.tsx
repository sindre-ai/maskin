import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SearchableMultiSelect } from '@/components/triggers/searchable-multi-select'

const mockUseIsMobile = vi.fn(() => false)
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => mockUseIsMobile(),
}))

const items = [
	{ id: 'one', label: 'One' },
	{ id: 'two', label: 'Two' },
]

afterEach(() => {
	mockUseIsMobile.mockReset()
	mockUseIsMobile.mockReturnValue(false)
})

describe('SearchableMultiSelect', () => {
	it('opens a popover on desktop', async () => {
		const user = userEvent.setup()
		mockUseIsMobile.mockReturnValue(false)
		render(<SearchableMultiSelect items={items} selectedIds={[]} onChange={() => {}} />)
		await user.click(screen.getByRole('button', { name: /Add/i }))
		const panel = await screen.findByRole('dialog')
		expect(panel.className).toMatch(/w-72/)
		expect(panel.className).not.toMatch(/rounded-t-lg/)
	})

	it('opens a bottom sheet on mobile', async () => {
		const user = userEvent.setup()
		mockUseIsMobile.mockReturnValue(true)
		render(
			<SearchableMultiSelect
				items={items}
				selectedIds={[]}
				onChange={() => {}}
				placeholder="Search options"
			/>,
		)
		await user.click(screen.getByRole('button', { name: /Add/i }))
		const sheet = await screen.findByRole('dialog')
		expect(sheet.className).toMatch(/rounded-t-lg/)
		expect(sheet.className).toMatch(/max-w-none/)
	})

	it('renders selected items as removable badges', async () => {
		const onChange = vi.fn()
		const user = userEvent.setup()
		mockUseIsMobile.mockReturnValue(false)
		render(<SearchableMultiSelect items={items} selectedIds={['one']} onChange={onChange} />)
		expect(screen.getByText('One')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: /Remove One/i }))
		expect(onChange).toHaveBeenCalledWith([])
	})
})
