import { DataTableToolbar } from '@/components/objects/data-table/data-table-toolbar'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

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
		quickChips: [],
		filterPills: [],
		onClearAllFilters: vi.fn(),
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
		...overrides,
	}
	return { ...render(<DataTableToolbar {...props} />), props }
}

describe('DataTableToolbar', () => {
	// The type-tab strip moved to the shared nav row (mockup 165–170); the
	// toolbar's own row carries the filters the user pinned out of the Display
	// panel, plus a pill per active filter.
	it('renders a chip per pinned quick filter', () => {
		renderToolbar({
			quickChips: [
				{ id: 'quick:fresh', label: 'New last 7 days', active: false, onToggle: vi.fn() },
				{ id: 'quick:starred', label: '★ Starred', active: true, onToggle: vi.fn() },
			],
		})
		expect(screen.getByRole('button', { name: 'New last 7 days' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: '★ Starred' })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
	})

	it('toggles the pinned filter a chip stands for', async () => {
		const user = userEvent.setup()
		const onToggle = vi.fn()
		renderToolbar({
			quickChips: [{ id: 'quick:fresh', label: 'New last 7 days', active: false, onToggle }],
		})
		await user.click(screen.getByRole('button', { name: 'New last 7 days' }))
		expect(onToggle).toHaveBeenCalledOnce()
	})

	it('renders no chip row when nothing is pinned', () => {
		renderToolbar({ quickChips: [] })
		// Only the mocked Display panel's trigger remains.
		expect(screen.getAllByRole('button')).toHaveLength(1)
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

	it('renders the mocked Display panel', () => {
		renderToolbar()
		expect(screen.getByRole('button', { name: 'MockDisplay' })).toBeInTheDocument()
	})

	it('forwards the filter sections and pin state through to the Display panel', () => {
		const filterSections = [{ id: 'status', label: 'Status', summary: 'Any status', options: [] }]
		const onTogglePinnedFilter = vi.fn()
		renderToolbar({
			filterSections,
			pinnedFilters: ['quick:fresh'],
			onTogglePinnedFilter,
		})
		const props = displayPanelProps.mock.calls.at(-1)?.[0] as Record<string, unknown>
		expect(props.filterSections).toEqual(filterSections)
		expect(props.pinnedFilters).toEqual(['quick:fresh'])
		expect(props.onTogglePinnedFilter).toBe(onTogglePinnedFilter)
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
})
