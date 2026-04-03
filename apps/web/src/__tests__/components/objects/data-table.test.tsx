import { getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable } from '@/components/objects/data-table/data-table'
import type { RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: count }, (_, i) => ({
				index: i,
				key: i,
				start: i * 48,
				size: 48,
			})),
		getTotalSize: () => count * 48,
	}),
}))

// jsdom does not support IntersectionObserver
globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

const defaultColumns = getStaticColumns({ workspaceId: 'ws-1' })

function renderDataTable(overrides: Partial<Parameters<typeof DataTable>[0]> = {}) {
	const props = {
		data: [],
		columns: defaultColumns,
		workspaceId: 'ws-1',
		rowSelection: {} as RowSelectionState,
		onRowSelectionChange: vi.fn(),
		columnVisibility: {} as VisibilityState,
		onColumnVisibilityChange: vi.fn(),
		...overrides,
	}
	return render(<DataTable {...props} />)
}

describe('DataTable', () => {
	beforeEach(() => {
		mockNavigate.mockClear()
	})

	it('shows empty state when data is empty', () => {
		renderDataTable({ data: [] })
		expect(screen.getByText('No objects found')).toBeInTheDocument()
	})

	it('shows loading spinner when isLoading is true', () => {
		renderDataTable({ isLoading: true })
		expect(screen.getByTitle('Loading')).toBeInTheDocument()
	})

	it('does not show empty state when loading', () => {
		renderDataTable({ isLoading: true, data: [] })
		expect(screen.queryByText('No objects found')).not.toBeInTheDocument()
	})

	it('renders rows with object titles', () => {
		const data = [
			buildObjectResponse({ title: 'First Object' }),
			buildObjectResponse({ title: 'Second Object' }),
		]
		renderDataTable({ data })
		expect(screen.getByText('First Object')).toBeInTheDocument()
		expect(screen.getByText('Second Object')).toBeInTheDocument()
	})

	it('navigates to object detail on row click', async () => {
		const user = userEvent.setup()
		const obj = buildObjectResponse({ id: 'obj-42', title: 'Clickable' })
		renderDataTable({ data: [obj], workspaceId: 'ws-1' })

		await user.click(screen.getByText('Clickable'))
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId: 'ws-1', objectId: 'obj-42' },
		})
	})

	it('shows fetching indicator when isFetchingNextPage is true', () => {
		const data = [buildObjectResponse({ title: 'Some Object' })]
		renderDataTable({ data, isFetchingNextPage: true })
		// The main table plus a loading spinner for pagination
		const spinners = screen.getAllByTitle('Loading')
		expect(spinners.length).toBeGreaterThanOrEqual(1)
	})
})
