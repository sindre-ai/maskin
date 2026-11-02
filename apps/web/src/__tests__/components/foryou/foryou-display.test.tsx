import { ForYouDisplay, forYouTypeOptions } from '@/components/foryou/foryou-display'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

function renderDisplay(overrides: Partial<React.ComponentProps<typeof ForYouDisplay>> = {}) {
	const props: React.ComponentProps<typeof ForYouDisplay> = {
		mode: 'cards',
		onModeChange: vi.fn(),
		typeFilter: undefined,
		onTypeFilterChange: vi.fn(),
		unreadCount: 7,
		typeCounts: new Map([
			['bet', 3],
			['insight', 2],
			['task', 0],
		]),
		filterPills: false,
		onFilterPillsChange: vi.fn(),
		...overrides,
	}
	return { props, ...render(<ForYouDisplay {...props} />) }
}

describe('forYouTypeOptions', () => {
	it('lists Everything first and drops types with no unread cards', () => {
		const options = forYouTypeOptions(
			7,
			new Map([
				['bet', 3],
				['task', 0],
			]),
		)
		expect(options.map((o) => [o.label, o.count])).toEqual([
			['Everything', 7],
			['Bets', 3],
		])
	})
})

describe('ForYouDisplay', () => {
	it('switches Cards and List from the View rail', async () => {
		const user = userEvent.setup()
		const { props } = renderDisplay()
		await user.click(screen.getByRole('button', { name: /Display/ }))
		await user.click(await screen.findByRole('button', { name: /View: List/ }))
		expect(props.onModeChange).toHaveBeenCalledWith('list')
	})

	it('filters from the Show block', async () => {
		const user = userEvent.setup()
		const { props } = renderDisplay()
		await user.click(screen.getByRole('button', { name: /Display/ }))
		expect(await screen.findByText('Show')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: /Insights/ }))
		expect(props.onTypeFilterChange).toHaveBeenCalledWith('insight')
	})

	it('counts the active type on the trigger and clears it when picked again', async () => {
		const user = userEvent.setup()
		const { props } = renderDisplay({ typeFilter: 'bet' })
		expect(screen.getByRole('button', { name: /Display/ })).toHaveTextContent('1')
		await user.click(screen.getByRole('button', { name: /Display/ }))
		await user.click(await screen.findByRole('button', { name: /^Bets/ }))
		expect(props.onTypeFilterChange).toHaveBeenCalledWith(undefined)
	})

	it('resets view, type and filter bar from Reset display', async () => {
		const user = userEvent.setup()
		const { props } = renderDisplay({ mode: 'list', typeFilter: 'bet', filterPills: true })
		await user.click(screen.getByRole('button', { name: /Display/ }))
		await user.click(await screen.findByText('Reset display'))
		expect(props.onModeChange).toHaveBeenCalledWith('cards')
		expect(props.onTypeFilterChange).toHaveBeenCalledWith(undefined)
		expect(props.onFilterPillsChange).toHaveBeenCalledWith(false)
	})

	it('toggles the filter bar under the header', async () => {
		const user = userEvent.setup()
		const { props } = renderDisplay()
		await user.click(screen.getByRole('button', { name: /Display/ }))
		await user.click(await screen.findByRole('button', { name: /Filter bar filter/ }))
		await user.click(await screen.findByRole('button', { name: 'Show under the header' }))
		expect(props.onFilterPillsChange).toHaveBeenCalledWith(true)
	})
})
