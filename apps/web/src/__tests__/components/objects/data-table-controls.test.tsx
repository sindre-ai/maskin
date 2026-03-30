import {
	DataTableControls,
	type ColumnInfo,
} from '@/components/objects/data-table/data-table-controls'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const defaultColumns: ColumnInfo[] = [
	{ id: 'title', label: 'Title', canHide: false },
	{ id: 'status', label: 'Status', canHide: true },
	{ id: 'owner', label: 'Owner', canHide: true },
]

function renderControls(overrides: Partial<React.ComponentProps<typeof DataTableControls>> = {}) {
	const props = {
		columns: defaultColumns,
		columnVisibility: {},
		onColumnVisibilityChange: vi.fn(),
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
		...overrides,
	}
	return { ...render(<DataTableControls {...props} />), props }
}

describe('DataTableControls', () => {
	it('renders Controls button', () => {
		renderControls()
		expect(screen.getByRole('button', { name: /controls/i })).toBeInTheDocument()
	})

	it('does not show filter badge when no active filters', () => {
		renderControls()
		const button = screen.getByRole('button', { name: /controls/i })
		expect(button.querySelector('span')).toBeNull()
	})

	it('shows badge with count 1 when statusFilter is set', () => {
		renderControls({ statusFilter: 'active' })
		expect(screen.getByText('1')).toBeInTheDocument()
	})

	it('shows badge with count 1 when ownerFilter is set', () => {
		renderControls({ ownerFilter: 'actor-1' })
		expect(screen.getByText('1')).toBeInTheDocument()
	})

	it('shows badge with count 2 when both filters are set', () => {
		renderControls({ statusFilter: 'active', ownerFilter: 'actor-1' })
		expect(screen.getByText('2')).toBeInTheDocument()
	})

	it('calls onStatusFilterChange when status checkbox is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderControls({
			statusesByType: { bet: ['active', 'closed'] },
		})

		await user.click(screen.getByRole('button', { name: /controls/i }))
		// Only status checkboxes rendered (no owner/column checkboxes): ["active", "closed"]
		const checkboxes = screen.getAllByRole('checkbox')
		await user.click(checkboxes[0])
		expect(props.onStatusFilterChange).toHaveBeenCalledWith('active')
	})

	it('calls onOwnerFilterChange when owner checkbox is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderControls({
			actors: [{ id: 'actor-1', name: 'Alice', type: 'human', email: null }],
		})

		await user.click(screen.getByRole('button', { name: /controls/i }))
		// Only owner checkboxes rendered (no status/column checkboxes): ["Alice"]
		const checkboxes = screen.getAllByRole('checkbox')
		await user.click(checkboxes[0])
		expect(props.onOwnerFilterChange).toHaveBeenCalledWith('actor-1')
	})

	it('calls onSortChange when a sort button is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderControls()

		await user.click(screen.getByRole('button', { name: /controls/i }))
		// Use getAllByRole since "Status" appears in both sort and group-by sections
		const statusButtons = screen.getAllByRole('button', { name: 'Status' })
		await user.click(statusButtons[0])
		expect(props.onSortChange).toHaveBeenCalledWith('status')
	})

	it('calls onOrderChange when order toggle is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderControls({ order: 'desc' })

		await user.click(screen.getByRole('button', { name: /controls/i }))
		await user.click(screen.getByRole('button', { name: /descending/i }))
		expect(props.onOrderChange).toHaveBeenCalledWith('asc')
	})

	it('calls onGroupByChange when group-by button is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderControls()

		await user.click(screen.getByRole('button', { name: /controls/i }))
		// "Status" appears in sort section (index 0) and group-by section (index 1)
		const statusButtons = screen.getAllByRole('button', { name: 'Status' })
		await user.click(statusButtons[1])
		expect(props.onGroupByChange).toHaveBeenCalledWith('status')
	})

	it('calls onColumnVisibilityChange when column checkbox is toggled', async () => {
		const user = userEvent.setup()
		const { props } = renderControls()

		await user.click(screen.getByRole('button', { name: /controls/i }))
		const checkboxes = screen.getAllByRole('checkbox')
		// Column visibility checkboxes are the only checkboxes (no status/owner filters rendered)
		await user.click(checkboxes[0])
		expect(props.onColumnVisibilityChange).toHaveBeenCalledWith('status', false)
	})

	it('calls onGroupByChange with undefined when None is clicked', async () => {
		const user = userEvent.setup()
		const { props } = renderControls({ groupBy: 'status' })

		await user.click(screen.getByRole('button', { name: /controls/i }))
		await user.click(screen.getByRole('button', { name: 'None' }))
		expect(props.onGroupByChange).toHaveBeenCalledWith(undefined)
	})
})
