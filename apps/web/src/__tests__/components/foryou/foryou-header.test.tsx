import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ForYouHeader } from '@/components/foryou/foryou-header'

function renderHeader(overrides: Partial<React.ComponentProps<typeof ForYouHeader>> = {}) {
	const props: React.ComponentProps<typeof ForYouHeader> = {
		unreadCount: 7,
		typeFilter: undefined,
		onTypeFilterChange: vi.fn(),
		typeCounts: new Map([
			['bet', 3],
			['insight', 2],
		]),
		mode: 'cards',
		onModeChange: vi.fn(),
		sort: 'attention',
		onSortChange: vi.fn(),
		filterPills: false,
		onFilterPillsChange: vi.fn(),
		bulkActions: [
			{ id: 'fyi', label: 'Dismiss all FYIs', count: 2, onSelect: vi.fn() },
			{ id: 'suggested', label: 'Take every suggested option', count: 0, onSelect: vi.fn() },
		],
		...overrides,
	}
	return { props, ...render(<ForYouHeader {...props} />) }
}

describe('ForYouHeader', () => {
	it('hides the filter pills until they are switched on', async () => {
		const user = userEvent.setup()
		const { rerender, props } = renderHeader()
		expect(screen.queryByRole('button', { name: 'Bets (3)' })).not.toBeInTheDocument()

		rerender(<ForYouHeader {...props} filterPills />)
		expect(screen.getByRole('button', { name: 'Everything (7)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Bets (3)' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Bets (3)' }))
		expect(props.onTypeFilterChange).toHaveBeenCalledWith('bet')
	})

	it('reads the active view, filter and sort back on the menu trigger', () => {
		renderHeader({ mode: 'list' })
		expect(screen.getByRole('button', { name: 'View options' })).toHaveTextContent('List')

		renderHeader({ mode: 'cards', typeFilter: 'bet', sort: 'chrono' })
		expect(screen.getAllByRole('button', { name: 'View options' })[1]).toHaveTextContent(
			'Cards · Bets · Chronological',
		)
	})

	it('switches the view mode from the menu', async () => {
		const user = userEvent.setup()
		const { props } = renderHeader({ mode: 'cards' })

		await user.click(screen.getByRole('button', { name: 'View options' }))
		await user.click(await screen.findByRole('menuitem', { name: /^List/ }))
		expect(props.onModeChange).toHaveBeenCalledWith('list')
	})

	it('changes the sort from the menu', async () => {
		const user = userEvent.setup()
		const { props } = renderHeader()

		await user.click(screen.getByRole('button', { name: 'View options' }))
		await user.click(await screen.findByRole('menuitem', { name: /Chronological/ }))
		expect(props.onSortChange).toHaveBeenCalledWith('chrono')
	})

	it('filters by type from the SHOW section', async () => {
		const user = userEvent.setup()
		const { props } = renderHeader()

		await user.click(screen.getByRole('button', { name: 'View options' }))
		await user.click(await screen.findByRole('menuitem', { name: /Insights/ }))
		expect(props.onTypeFilterChange).toHaveBeenCalledWith('insight')
	})

	it('toggles the filter bar from the last row of the menu', async () => {
		const user = userEvent.setup()
		const { props } = renderHeader()

		await user.click(screen.getByRole('button', { name: 'View options' }))
		await user.click(await screen.findByRole('menuitem', { name: /Filter bar under the header/ }))
		expect(props.onFilterPillsChange).toHaveBeenCalledWith(true)
	})

	it('runs a bulk action from the ··· menu, and disables the empty ones', async () => {
		const user = userEvent.setup()
		const { props } = renderHeader()

		await user.click(screen.getByRole('button', { name: 'Feed actions' }))
		const empty = await screen.findByRole('menuitem', { name: /Take every suggested option/ })
		expect(empty).toHaveAttribute('aria-disabled', 'true')

		await user.click(screen.getByRole('menuitem', { name: /Dismiss all FYIs/ }))
		expect(props.bulkActions[0]?.onSelect).toHaveBeenCalledTimes(1)
	})
})
