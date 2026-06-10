import {
	DisplayPanel,
	type DisplayPanelColumn,
} from '@/components/objects/data-table/display-panel'
import { render, screen, within } from '@testing-library/react'
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
		ownerFilter: undefined,
		onOwnerFilterChange: vi.fn(),
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
		renderPanel({ statusFilter: 'active', ownerFilter: 'actor-1' })
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
		const { props } = renderPanel({ statusFilter: 'active', ownerFilter: 'a1' })
		await user.click(screen.getByRole('button', { name: /display/i }))
		await user.click(screen.getByRole('button', { name: /reset/i }))
		expect(props.onStatusFilterChange).toHaveBeenCalledWith(undefined)
		expect(props.onOwnerFilterChange).toHaveBeenCalledWith(undefined)
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

	it('shows "+ Status" / "+ Owner" affordances when no filter is set', async () => {
		const user = userEvent.setup()
		renderPanel({
			actors: [{ id: 'a1', name: 'Alice', type: 'human', createdAt: '', updatedAt: '' } as never],
		})
		await user.click(screen.getByRole('button', { name: /display/i }))
		expect(screen.getByRole('button', { name: /\+ Status/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /\+ Owner/i })).toBeInTheDocument()
	})
})
