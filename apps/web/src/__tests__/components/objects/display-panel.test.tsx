import {
	DisplayPanel,
	type DisplayPanelColumn,
} from '@/components/objects/data-table/display-panel'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const defaultColumns: DisplayPanelColumn[] = [
	{ id: 'title', label: 'Title', canHide: false },
	{ id: 'status', label: 'Status', canHide: true },
	{ id: 'owner', label: 'Owner', canHide: true },
	{ id: 'createdAt', label: 'Created', canHide: true },
]

function renderPanel(overrides: Partial<React.ComponentProps<typeof DisplayPanel>> = {}) {
	const props = {
		columns: defaultColumns,
		columnVisibility: {},
		onColumnVisibilityChange: vi.fn(),
		statusFilter: undefined,
		onStatusFilterChange: vi.fn(),
		statuses: ['active', 'closed'],
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
	return { ...render(<DisplayPanel {...props} />), props }
}

describe('DisplayPanel', () => {
	it('renders Display trigger button', () => {
		renderPanel()
		expect(screen.getByRole('button', { name: /display/i })).toBeInTheDocument()
	})

	it('does not show filter badge when no active filters', () => {
		renderPanel()
		const button = screen.getByRole('button', { name: /display/i })
		expect(button.querySelector('span')).toBeNull()
	})

	it('shows badge with count 1 when statusFilter is set', () => {
		renderPanel({ statusFilter: 'active' })
		expect(screen.getByText('1')).toBeInTheDocument()
	})

	it('shows badge with count 2 when both status and owner are set', () => {
		renderPanel({ statusFilter: 'active', driverFilter: 'actor-1' })
		expect(screen.getByText('2')).toBeInTheDocument()
	})

	it('opens panel and renders the five section headers', async () => {
		const user = userEvent.setup()
		renderPanel({
			actors: [{ id: 'a1', name: 'Alice', type: 'human', createdAt: '', updatedAt: '' } as never],
		})
		await user.click(screen.getByRole('button', { name: /display/i }))
		expect(screen.getByText('View')).toBeInTheDocument()
		expect(screen.getByText('Ordering')).toBeInTheDocument()
		expect(screen.getByText('Grouping')).toBeInTheDocument()
		expect(screen.getByText('Filters')).toBeInTheDocument()
		expect(screen.getByText('Properties')).toBeInTheDocument()
	})

	it('renders both List and Board pills when board is supported (default)', async () => {
		const user = userEvent.setup()
		renderPanel()
		await user.click(screen.getByRole('button', { name: /display/i }))
		expect(screen.getByRole('button', { name: 'List' })).toBeInTheDocument()
		const board = screen.getByRole('button', { name: 'Board' })
		expect(board).toBeInTheDocument()
		expect(board).not.toBeDisabled()
	})

	it('disables Board pill when boardSupported is false', async () => {
		const user = userEvent.setup()
		renderPanel({ boardSupported: false })
		await user.click(screen.getByRole('button', { name: /display/i }))
		const board = screen.getByRole('button', { name: 'Board' })
		expect(board).toBeDisabled()
		expect(board).toHaveAttribute('title', expect.stringContaining('statuses'))
	})

	it('calls onViewChange when Board is clicked', async () => {
		const user = userEvent.setup()
		const onViewChange = vi.fn()
		renderPanel({ view: 'list', onViewChange })
		await user.click(screen.getByRole('button', { name: /display/i }))
		await user.click(screen.getByRole('button', { name: 'Board' }))
		expect(onViewChange).toHaveBeenCalledWith('board')
	})

	it('calls onViewChange when List is clicked from board view', async () => {
		const user = userEvent.setup()
		const onViewChange = vi.fn()
		renderPanel({ view: 'board', onViewChange })
		await user.click(screen.getByRole('button', { name: /display/i }))
		await user.click(screen.getByRole('button', { name: 'List' }))
		expect(onViewChange).toHaveBeenCalledWith('list')
	})

	it('does not call onViewChange when disabled Board is clicked', async () => {
		const user = userEvent.setup()
		const onViewChange = vi.fn()
		renderPanel({ boardSupported: false, onViewChange })
		await user.click(screen.getByRole('button', { name: /display/i }))
		await user.click(screen.getByRole('button', { name: 'Board' }))
		expect(onViewChange).not.toHaveBeenCalled()
	})

	it('toggles order when the asc/desc affordance is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderPanel({ order: 'desc' })
		await user.click(screen.getByRole('button', { name: /display/i }))
		await user.click(screen.getByRole('button', { name: /descending/i }))
		expect(props.onOrderChange).toHaveBeenCalledWith('asc')
	})

	it('offers Manual ordering only in board view', async () => {
		const user = userEvent.setup()
		const { props } = renderPanel({ view: 'board' })
		await user.click(screen.getByRole('button', { name: /display/i }))
		const orderingSection = screen.getByText('Ordering').closest('div') as HTMLElement
		await user.click(within(orderingSection).getByRole('button', { name: /created/i }))
		await user.click(screen.getByRole('menuitem', { name: /manual/i }))
		expect(props.onSortChange).toHaveBeenCalledWith('boardOrder')
	})

	it('hides the direction toggle for Manual board ordering', async () => {
		const user = userEvent.setup()
		renderPanel({ view: 'board', sort: 'boardOrder', order: 'asc' })
		await user.click(screen.getByRole('button', { name: /display/i }))
		expect(screen.getByRole('button', { name: /manual/i })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /ascending/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /descending/i })).not.toBeInTheDocument()
	})

	it('clears both filters when Reset is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderPanel({ statusFilter: 'active', driverFilter: 'a1' })
		await user.click(screen.getByRole('button', { name: /display/i }))
		await user.click(screen.getByRole('button', { name: /reset/i }))
		expect(props.onStatusFilterChange).toHaveBeenCalledWith(undefined)
		expect(props.onDriverFilterChange).toHaveBeenCalledWith(undefined)
	})

	it('renders one pill per hideable column in Properties', async () => {
		const user = userEvent.setup()
		renderPanel({ columnVisibility: { status: true, owner: false, createdAt: true } })
		await user.click(screen.getByRole('button', { name: /display/i }))
		const propertiesSection = screen.getByText('Properties').closest('div') as HTMLElement
		expect(within(propertiesSection).getByRole('button', { name: 'Status' })).toBeInTheDocument()
		expect(within(propertiesSection).getByRole('button', { name: 'Owner' })).toBeInTheDocument()
		expect(within(propertiesSection).getByRole('button', { name: 'Created' })).toBeInTheDocument()
		// Non-hideable column does not get a pill
		expect(within(propertiesSection).queryByRole('button', { name: 'Title' })).toBeNull()
	})

	it('toggles a column when its property pill is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderPanel({ columnVisibility: { status: true } })
		await user.click(screen.getByRole('button', { name: /display/i }))
		const propertiesSection = screen.getByText('Properties').closest('div') as HTMLElement
		await user.click(within(propertiesSection).getByRole('button', { name: 'Status' }))
		expect(props.onColumnVisibilityChange).toHaveBeenCalledWith('status', false)
	})

	it('hides the View section when showView=false', async () => {
		const user = userEvent.setup()
		renderPanel({ showView: false })
		await user.click(screen.getByRole('button', { name: /display/i }))
		expect(screen.queryByText('View')).toBeNull()
		expect(screen.queryByRole('button', { name: 'List' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()
		// Other sections still render.
		expect(screen.getByText('Ordering')).toBeInTheDocument()
	})

	it('shows "+ Status" / "+ Driver" affordances when no filter is set', async () => {
		const user = userEvent.setup()
		renderPanel({
			actors: [{ id: 'a1', name: 'Alice', type: 'human', createdAt: '', updatedAt: '' } as never],
		})
		await user.click(screen.getByRole('button', { name: /display/i }))
		expect(screen.getByRole('button', { name: /\+ Status/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /\+ Driver/i })).toBeInTheDocument()
	})

	describe('metadata filters', () => {
		it('renders one filter row per field definition', async () => {
			const user = userEvent.setup()
			renderPanel({
				fieldDefinitions: [
					{ name: 'region', type: 'text' },
					{ name: 'tier', type: 'enum', values: ['gold', 'silver'] },
				],
				metadataFilters: {},
				onMetadataFilterChange: vi.fn(),
			})
			await user.click(screen.getByRole('button', { name: /display/i }))
			expect(screen.getByText('region')).toBeInTheDocument()
			expect(screen.getByText('tier')).toBeInTheDocument()
		})

		it('does not render metadata rows when there are no field definitions', async () => {
			const user = userEvent.setup()
			renderPanel({ fieldDefinitions: [], metadataFilters: {}, onMetadataFilterChange: vi.fn() })
			await user.click(screen.getByRole('button', { name: /display/i }))
			expect(screen.queryByPlaceholderText('Any')).toBeNull()
		})

		it('calls onMetadataFilterChange when typing in a text metadata filter', async () => {
			const user = userEvent.setup()
			const onMetadataFilterChange = vi.fn()
			renderPanel({
				fieldDefinitions: [{ name: 'region', type: 'text' }],
				metadataFilters: {},
				onMetadataFilterChange,
			})
			await user.click(screen.getByRole('button', { name: /display/i }))
			fireEvent.change(screen.getByPlaceholderText('Any'), { target: { value: 'emea' } })
			expect(onMetadataFilterChange).toHaveBeenCalledWith('region', 'emea')
		})

		it('calls onMetadataFilterChange with the selected enum value', async () => {
			const user = userEvent.setup()
			const onMetadataFilterChange = vi.fn()
			renderPanel({
				fieldDefinitions: [{ name: 'tier', type: 'enum', values: ['gold', 'silver'] }],
				metadataFilters: {},
				onMetadataFilterChange,
			})
			await user.click(screen.getByRole('button', { name: /display/i }))
			await user.click(screen.getByRole('combobox'))
			await user.click(screen.getByRole('option', { name: 'gold' }))
			expect(onMetadataFilterChange).toHaveBeenCalledWith('tier', 'gold')
		})

		it('clears a metadata filter via the Clear button when a value is set', async () => {
			const user = userEvent.setup()
			const onMetadataFilterChange = vi.fn()
			renderPanel({
				fieldDefinitions: [{ name: 'region', type: 'text' }],
				metadataFilters: { region: 'emea' },
				onMetadataFilterChange,
			})
			await user.click(screen.getByRole('button', { name: /display/i }))
			await user.click(screen.getByRole('button', { name: /clear region filter/i }))
			expect(onMetadataFilterChange).toHaveBeenCalledWith('region', undefined)
		})

		it('counts an active metadata filter in the badge', () => {
			renderPanel({
				fieldDefinitions: [{ name: 'region', type: 'text' }],
				metadataFilters: { region: 'emea' },
				onMetadataFilterChange: vi.fn(),
			})
			expect(screen.getByText('1')).toBeInTheDocument()
		})

		it('still counts and can reset a metadata filter when the active tab has no field definitions for it', async () => {
			// Mirrors the "All" objects tab: fieldDefinitions is empty there because
			// field definitions are per-type, but a metadata filter set on another
			// tab is still applied to the query and must stay visible/clearable.
			const user = userEvent.setup()
			const onResetFilters = vi.fn()
			renderPanel({
				fieldDefinitions: [],
				metadataFilters: { region: 'emea' },
				onMetadataFilterChange: vi.fn(),
				onResetFilters,
			})
			expect(screen.getByText('1')).toBeInTheDocument()
			await user.click(screen.getByRole('button', { name: /display/i }))
			await user.click(screen.getByRole('button', { name: /reset/i }))
			expect(onResetFilters).toHaveBeenCalled()
		})

		it('excludes a field whose name cannot be filtered and explains why, instead of rendering a row that would silently fail', async () => {
			// Field names are workspace-defined and unconstrained (spaces, hyphens,
			// etc. are all valid `create_workspace_field` names), but a filter row
			// only works for names matching SAFE_METADATA_FIELD_NAME_RE — anything
			// else gets dropped by the URL search-param validator with no error.
			// Rendering an input for it would look like a working filter that then
			// silently discards whatever the user types.
			const user = userEvent.setup()
			renderPanel({
				fieldDefinitions: [
					{ name: 'region', type: 'text' },
					{ name: 'deal size', type: 'text' },
				],
				metadataFilters: {},
				onMetadataFilterChange: vi.fn(),
			})
			await user.click(screen.getByRole('button', { name: /display/i }))
			expect(screen.getByText('region')).toBeInTheDocument()
			expect(screen.queryByText('deal size')).toBeNull()
			expect(screen.getByText(/1 field can't be filtered/i)).toBeInTheDocument()
		})

		it('pluralizes the excluded-field note for more than one unfilterable field', async () => {
			const user = userEvent.setup()
			renderPanel({
				fieldDefinitions: [
					{ name: 'deal size', type: 'text' },
					{ name: 'cost-per-lead', type: 'number' },
				],
				metadataFilters: {},
				onMetadataFilterChange: vi.fn(),
			})
			await user.click(screen.getByRole('button', { name: /display/i }))
			expect(screen.getByText(/2 fields can't be filtered/i)).toBeInTheDocument()
		})

		it('shows no excluded-field note when every field definition is filterable', async () => {
			const user = userEvent.setup()
			renderPanel({
				fieldDefinitions: [{ name: 'region', type: 'text' }],
				metadataFilters: {},
				onMetadataFilterChange: vi.fn(),
			})
			await user.click(screen.getByRole('button', { name: /display/i }))
			expect(screen.queryByText(/can't be filtered/i)).toBeNull()
		})
	})

	describe('Show — Include archived', () => {
		it('does not render the Show section when onIncludeArchivedChange is unset', async () => {
			const user = userEvent.setup()
			renderPanel()
			await user.click(screen.getByRole('button', { name: /display/i }))
			expect(screen.queryByText('Show')).toBeNull()
			expect(screen.queryByRole('switch', { name: /include archived/i })).toBeNull()
		})

		it('renders the Show section and reflects the current includeArchived state', async () => {
			const user = userEvent.setup()
			renderPanel({ includeArchived: true, onIncludeArchivedChange: vi.fn() })
			await user.click(screen.getByRole('button', { name: /display/i }))
			expect(screen.getByText('Show')).toBeInTheDocument()
			const toggle = screen.getByRole('switch', { name: /include archived/i })
			expect(toggle).toBeInTheDocument()
			expect(toggle).toHaveAttribute('data-state', 'checked')
		})

		it('calls onIncludeArchivedChange when the switch is toggled', async () => {
			const user = userEvent.setup()
			const onIncludeArchivedChange = vi.fn()
			renderPanel({ includeArchived: false, onIncludeArchivedChange })
			await user.click(screen.getByRole('button', { name: /display/i }))
			await user.click(screen.getByRole('switch', { name: /include archived/i }))
			expect(onIncludeArchivedChange).toHaveBeenCalledWith(true)
		})

		it('counts the includeArchived flag in the trigger badge', () => {
			renderPanel({ includeArchived: true, onIncludeArchivedChange: vi.fn() })
			expect(screen.getByText('1')).toBeInTheDocument()
		})

		it('adds +1 to the badge on top of an existing status filter', () => {
			renderPanel({
				includeArchived: true,
				onIncludeArchivedChange: vi.fn(),
				statusFilter: 'active',
			})
			expect(screen.getByText('2')).toBeInTheDocument()
		})

		it('renders "+ archived" inline next to the Display trigger when on', () => {
			renderPanel({ includeArchived: true, onIncludeArchivedChange: vi.fn() })
			expect(screen.getByText('+ archived')).toBeInTheDocument()
		})

		it('does not render the inline "+ archived" reading when the flag is off', () => {
			renderPanel({ includeArchived: false, onIncludeArchivedChange: vi.fn() })
			expect(screen.queryByText('+ archived')).toBeNull()
		})

		it('does not render the inline "+ archived" reading on the iconOnly (mobile) trigger', () => {
			renderPanel({ includeArchived: true, onIncludeArchivedChange: vi.fn(), iconOnly: true })
			expect(screen.queryByText('+ archived')).toBeNull()
			// The icon-only trigger still carries the count pill so mobile
			// users can see the flag is on without opening the panel.
			expect(screen.getByText('1')).toBeInTheDocument()
		})
	})
})
