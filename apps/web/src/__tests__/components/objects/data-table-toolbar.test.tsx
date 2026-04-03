import { DataTableToolbar } from '@/components/objects/data-table/data-table-toolbar'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/objects/data-table/data-table-controls', () => ({
	DataTableControls: () => <button type="button">MockControls</button>,
}))

function renderToolbar(overrides: Partial<React.ComponentProps<typeof DataTableToolbar>> = {}) {
	const props = {
		columns: [],
		columnVisibility: {},
		onColumnVisibilityChange: vi.fn(),
		tabs: [
			{ label: 'All', value: undefined },
			{ label: 'Bets', value: 'bet' },
			{ label: 'Tasks', value: 'task' },
		],
		typeFilter: undefined,
		onTypeFilterChange: vi.fn(),
		search: '',
		onSearchChange: vi.fn(),
		statusFilter: undefined,
		onStatusFilterChange: vi.fn(),
		statusesByType: {},
		ownerFilter: undefined,
		onOwnerFilterChange: vi.fn(),
		actors: [],
		sort: 'createdAt',
		onSortChange: vi.fn(),
		order: 'desc' as const,
		onOrderChange: vi.fn(),
		groupBy: undefined,
		onGroupByChange: vi.fn(),
		onImportClick: vi.fn(),
		...overrides,
	}
	return { ...render(<DataTableToolbar {...props} />), props }
}

describe('DataTableToolbar', () => {
	it('renders type tab buttons', () => {
		renderToolbar()
		expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Bets' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument()
	})

	it('calls onTypeFilterChange when a tab is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderToolbar()

		await user.click(screen.getByRole('button', { name: 'Bets' }))
		expect(props.onTypeFilterChange).toHaveBeenCalledWith('bet')
	})

	it('calls onTypeFilterChange with undefined for All tab', async () => {
		const user = userEvent.setup()
		const { props } = renderToolbar({ typeFilter: 'bet' })

		await user.click(screen.getByRole('button', { name: 'All' }))
		expect(props.onTypeFilterChange).toHaveBeenCalledWith(undefined)
	})

	it('renders search input with placeholder', () => {
		renderToolbar()
		expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument()
	})

	it('renders Import button', () => {
		renderToolbar()
		expect(screen.getByRole('button', { name: /import/i })).toBeInTheDocument()
	})

	it('calls onImportClick when Import is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderToolbar()

		await user.click(screen.getByRole('button', { name: /import/i }))
		expect(props.onImportClick).toHaveBeenCalledOnce()
	})

	it('renders the mocked Controls component', () => {
		renderToolbar()
		expect(screen.getByRole('button', { name: 'MockControls' })).toBeInTheDocument()
	})

	it('shows current search value in input', () => {
		renderToolbar({ search: 'existing' })
		expect(screen.getByDisplayValue('existing')).toBeInTheDocument()
	})

	describe('search debounce', () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('debounces search input by 300ms', () => {
			const { props } = renderToolbar()

			const input = screen.getByPlaceholderText('Search...')
			fireEvent.change(input, { target: { value: 'hello' } })

			expect(props.onSearchChange).not.toHaveBeenCalled()

			vi.advanceTimersByTime(300)
			expect(props.onSearchChange).toHaveBeenCalledWith('hello')
		})

		it('resets debounce on subsequent typing', () => {
			const { props } = renderToolbar()

			const input = screen.getByPlaceholderText('Search...')
			fireEvent.change(input, { target: { value: 'he' } })

			vi.advanceTimersByTime(200)
			expect(props.onSearchChange).not.toHaveBeenCalled()

			fireEvent.change(input, { target: { value: 'hello' } })
			vi.advanceTimersByTime(300)
			expect(props.onSearchChange).toHaveBeenCalledWith('hello')
		})
	})
})
