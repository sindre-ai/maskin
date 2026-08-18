import { DataTableToolbar } from '@/components/objects/data-table/data-table-toolbar'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { displayPanelProps } = vi.hoisted(() => ({ displayPanelProps: vi.fn() }))

vi.mock('@/components/objects/data-table/display-panel', () => ({
	DisplayPanel: (props: Record<string, unknown>) => {
		displayPanelProps(props)
		return <button type="button">MockDisplay</button>
	},
}))

function renderToolbar(overrides: Partial<React.ComponentProps<typeof DataTableToolbar>> = {}) {
	const props = {
		columns: [],
		columnVisibility: {},
		onColumnVisibilityChange: vi.fn(),
		axisChips: [
			{ label: 'All', value: undefined },
			{ label: 'Active', value: 'active', count: 2 },
			{ label: 'Done', value: 'done', count: 1 },
		],
		axisValue: undefined,
		onAxisValueChange: vi.fn(),
		filterPills: [],
		onClearAllFilters: vi.fn(),
		search: '',
		onSearchChange: vi.fn(),
		statusFilter: undefined,
		onStatusFilterChange: vi.fn(),
		statusesByType: {},
		driverFilter: undefined,
		onDriverFilterChange: vi.fn(),
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
	// The type-tab strip moved to the shared nav row (mockup 165–170); the
	// toolbar's own chip row now carries the active FILTER BY axis's values.
	it('renders a value chip per axis option, counts spoken but drawn bare', () => {
		renderToolbar()
		expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Active (2)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Done (1)' })).toBeInTheDocument()
	})

	it('calls onAxisValueChange when a value chip is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderToolbar()

		await user.click(screen.getByRole('button', { name: 'Active (2)' }))
		expect(props.onAxisValueChange).toHaveBeenCalledWith('active')
	})

	it('calls onAxisValueChange with undefined for the All chip', async () => {
		const user = userEvent.setup()
		const { props } = renderToolbar({ axisValue: 'active' })

		await user.click(screen.getByRole('button', { name: 'All' }))
		expect(props.onAxisValueChange).toHaveBeenCalledWith(undefined)
	})

	it('renders a removable pill per active filter and clears it', async () => {
		const user = userEvent.setup()
		const onRemove = vi.fn()
		renderToolbar({
			filterPills: [{ id: 'status', label: 'Status', value: 'active', onRemove }],
		})
		expect(screen.getByText('Status:')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Remove Status filter' }))
		expect(onRemove).toHaveBeenCalledOnce()
	})

	// Mockup 920 (`objPillsMany`): a single pill's own × already clears it.
	it('shows Clear all only once more than one pill is active', async () => {
		const user = userEvent.setup()
		const { unmount } = renderToolbar({
			filterPills: [{ id: 'status', label: 'Status', value: 'active', onRemove: vi.fn() }],
		})
		expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull()
		unmount()

		const { props } = renderToolbar({
			filterPills: [
				{ id: 'status', label: 'Status', value: 'active', onRemove: vi.fn() },
				{ id: 'driver', label: 'Driver', value: 'Ada', onRemove: vi.fn() },
			],
		})
		await user.click(screen.getByRole('button', { name: 'Clear all' }))
		expect(props.onClearAllFilters).toHaveBeenCalledOnce()
	})

	it('renders search input with placeholder', () => {
		renderToolbar()
		expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument()
	})

	it('renders Import button', () => {
		renderToolbar()
		expect(screen.getByRole('button', { name: /import/i })).toBeInTheDocument()
	})

	it('keeps the action cluster on its own row on small viewports', () => {
		// Search + Display + Import sit on `basis-full` (own row) below `sm:` so
		// narrow viewports wrap predictably; `sm:basis-auto` restores the single
		// right-aligned row the mockup shows at 921.
		renderToolbar()
		const importBtn = screen.getByRole('button', { name: /import/i })
		const cluster = importBtn.parentElement
		expect(cluster).not.toBeNull()
		expect(cluster?.className).toContain('basis-full')
		expect(cluster?.className).toContain('sm:basis-auto')
		expect(cluster?.className).toContain('justify-end')
	})

	it('calls onImportClick when Import is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderToolbar()

		await user.click(screen.getByRole('button', { name: /import/i }))
		expect(props.onImportClick).toHaveBeenCalledOnce()
	})

	it('renders the mocked Display panel', () => {
		renderToolbar()
		expect(screen.getByRole('button', { name: 'MockDisplay' })).toBeInTheDocument()
	})

	it('forwards metadata filter props through to the Display panel', () => {
		const fieldDefinitions = [{ name: 'region', type: 'text' as const }]
		const metadataFilters = { region: 'emea' }
		const onMetadataFilterChange = vi.fn()
		renderToolbar({ fieldDefinitions, metadataFilters, onMetadataFilterChange })
		const props = displayPanelProps.mock.calls.at(-1)?.[0] as Record<string, unknown>
		expect(props.fieldDefinitions).toEqual(fieldDefinitions)
		expect(props.metadataFilters).toEqual(metadataFilters)
		expect(props.onMetadataFilterChange).toBe(onMetadataFilterChange)
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
