import { getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable } from '@/components/objects/data-table/data-table'
import type { RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ButtonHTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { buildObjectResponse } from '../../factories'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
	Link: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
		const { to, params, onClick, ...rest } = props
		return (
			<button
				type="button"
				{...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
				onClick={(e) => {
					if (typeof onClick === 'function') {
						;(onClick as (ev: ReactMouseEvent<HTMLButtonElement>) => void)(e)
					}
					e.preventDefault()
					mockNavigate({ to, params })
				}}
			>
				{children}
			</button>
		)
	},
}))

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

// useIsMobile is overridden per-test via `mockIsMobile`. Default desktop so the
// existing table-render assertions keep passing without changes.
const mockIsMobile = vi.fn(() => false)
const mockIsTouchViewport = vi.fn(() => false)
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => mockIsMobile(),
	useIsTouchViewport: () => mockIsTouchViewport(),
}))

// DataTable fetches actors for the mobile card view's owner label.
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
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
		measureElement: vi.fn(),
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
		mockIsMobile.mockReturnValue(false)
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

	describe('grouped rows — chevron scoping and header select-all', () => {
		it('selects every leaf row in the group when the header checkbox is checked (desktop)', async () => {
			const user = userEvent.setup()
			const data = [
				buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
				buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
			]
			let selection: RowSelectionState = {}
			const onRowSelectionChange = vi.fn((updater) => {
				selection =
					typeof updater === 'function'
						? (updater as (s: RowSelectionState) => RowSelectionState)(selection)
						: updater
			})
			renderDataTable({ data, grouping: ['status'], rowSelection: selection, onRowSelectionChange })

			const groupChevron = screen.getByRole('button', { expanded: false })
			await user.click(groupChevron)

			const groupCheckbox = screen.getByRole('checkbox', { name: /select all in active/i })
			await user.click(groupCheckbox)

			expect(selection).toEqual({ a: true, b: true })
		})

		it('clears every leaf row in the group when the header checkbox is unchecked (desktop)', async () => {
			const user = userEvent.setup()
			const data = [
				buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
				buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
			]
			let selection: RowSelectionState = { a: true, b: true }
			const onRowSelectionChange = vi.fn((updater) => {
				selection =
					typeof updater === 'function'
						? (updater as (s: RowSelectionState) => RowSelectionState)(selection)
						: updater
			})
			renderDataTable({ data, grouping: ['status'], rowSelection: selection, onRowSelectionChange })

			const groupChevron = screen.getByRole('button', { expanded: false })
			await user.click(groupChevron)

			const groupCheckbox = screen.getByRole('checkbox', { name: /select all in active/i })
			expect(groupCheckbox).toHaveAttribute('data-state', 'checked')
			await user.click(groupCheckbox)

			expect(selection).toEqual({})
		})

		it('renders the indeterminate state when only some leaf rows are selected (desktop)', () => {
			const data = [
				buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
				buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
			]
			renderDataTable({
				data,
				grouping: ['status'],
				rowSelection: { a: true } as RowSelectionState,
			})

			const groupCheckbox = screen.getByRole('checkbox', { name: /select all in active/i })
			expect(groupCheckbox).toHaveAttribute('data-state', 'indeterminate')
		})

		it('does not toggle expansion when the group-header checkbox is clicked (desktop)', async () => {
			const user = userEvent.setup()
			const data = [
				buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
				buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
			]
			renderDataTable({ data, grouping: ['status'] })

			const groupChevron = screen.getByRole('button', { expanded: false })
			await user.click(groupChevron)

			const groupCheckbox = screen.getByRole('checkbox', { name: /select all in active/i })
			await user.click(groupCheckbox)

			expect(screen.getByText('Alpha')).toBeInTheDocument()
			expect(screen.getByText('Beta')).toBeInTheDocument()
			expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
		})

		it('keeps the group expanded after a child-row checkbox is clicked (desktop)', async () => {
			const user = userEvent.setup()
			const data = [
				buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
				buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
			]
			renderDataTable({ data, grouping: ['status'] })

			// Group header renders even when collapsed — open it via the chevron button.
			const groupToggle = screen.getByRole('button', { expanded: false })
			await user.click(groupToggle)
			expect(screen.getByText('Alpha')).toBeInTheDocument()
			expect(screen.getByText('Beta')).toBeInTheDocument()

			const [firstRowCheckbox] = screen.getAllByRole('checkbox', { name: 'Select row' })
			await user.click(firstRowCheckbox as HTMLElement)

			// Group must still be expanded; both children remain in the DOM.
			expect(screen.getByText('Alpha')).toBeInTheDocument()
			expect(screen.getByText('Beta')).toBeInTheDocument()
			expect(screen.getByRole('button', { expanded: true })).toBe(groupToggle)
		})

		it('chevron button still toggles expansion (desktop)', async () => {
			const user = userEvent.setup()
			const data = [
				buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
				buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
			]
			renderDataTable({ data, grouping: ['status'] })

			const groupToggle = screen.getByRole('button', { expanded: false })
			await user.click(groupToggle)
			expect(screen.getByText('Alpha')).toBeInTheDocument()

			await user.click(screen.getByRole('button', { expanded: true }))
			expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
		})

		it('selects every leaf row in the group when the header checkbox is checked (mobile)', async () => {
			mockIsMobile.mockReturnValue(true)
			const user = userEvent.setup()
			const data = [
				buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
				buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
			]
			let selection: RowSelectionState = {}
			const onRowSelectionChange = vi.fn((updater) => {
				selection =
					typeof updater === 'function'
						? (updater as (s: RowSelectionState) => RowSelectionState)(selection)
						: updater
			})
			renderDataTable({ data, grouping: ['status'], rowSelection: selection, onRowSelectionChange })

			const groupCheckbox = screen.getByRole('checkbox', { name: /select all in active/i })
			await user.click(groupCheckbox)

			expect(selection).toEqual({ a: true, b: true })
		})

		it('keeps the group expanded after a child-row checkbox is clicked (mobile)', async () => {
			mockIsMobile.mockReturnValue(true)
			const user = userEvent.setup()
			const data = [
				buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
				buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
			]
			renderDataTable({ data, grouping: ['status'] })

			const groupToggle = screen.getByRole('button', { name: /active/i })
			await user.click(groupToggle)
			expect(screen.getByText('Alpha')).toBeInTheDocument()
			expect(screen.getByText('Beta')).toBeInTheDocument()

			const [firstRowCheckbox] = screen.getAllByRole('checkbox', { name: 'Select row' })
			await user.click(firstRowCheckbox as HTMLElement)

			expect(screen.getByText('Alpha')).toBeInTheDocument()
			expect(screen.getByText('Beta')).toBeInTheDocument()
		})

		it('keeps the group expanded across a parent re-render (autoResetExpanded: false)', async () => {
			const user = userEvent.setup()
			const data = [
				buildObjectResponse({ id: 'obj-c', title: 'Gamma', createdBy: 'actor-y' }),
				buildObjectResponse({ id: 'obj-d', title: 'Delta', createdBy: 'actor-y' }),
			]
			const props = {
				data,
				columns: defaultColumns,
				workspaceId: 'ws-1',
				rowSelection: {} as RowSelectionState,
				onRowSelectionChange: vi.fn(),
				columnVisibility: {} as VisibilityState,
				onColumnVisibilityChange: vi.fn(),
				grouping: ['createdBy'],
			}
			const { rerender } = render(<DataTable {...props} />)

			await user.click(screen.getByRole('button', { name: /\(2\)/ }))
			expect(screen.getByText('Gamma')).toBeInTheDocument()

			// Simulate a parent re-render (e.g. closing the left nav) that passes
			// through a fresh data reference. Without autoResetExpanded: false,
			// TanStack Table would collapse the group on this cycle.
			await act(async () => {
				rerender(<DataTable {...props} data={[...data]} />)
			})

			expect(screen.getByText('Gamma')).toBeInTheDocument()
			expect(screen.getByText('Delta')).toBeInTheDocument()
		})
	})

	describe('mobile (below md)', () => {
		beforeEach(() => {
			mockIsMobile.mockReturnValue(true)
		})

		it('renders objects as a card list instead of a table', () => {
			const data = [buildObjectResponse({ title: 'Card Object' })]
			renderDataTable({ data })
			// The mobile path is a role="list", not a <table>.
			expect(screen.getByRole('list', { name: 'Objects' })).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			expect(screen.getByText('Card Object')).toBeInTheDocument()
		})

		it('navigates to object detail on card click', async () => {
			const user = userEvent.setup()
			const obj = buildObjectResponse({ id: 'obj-7', title: 'Tap me' })
			renderDataTable({ data: [obj], workspaceId: 'ws-1' })

			await user.click(screen.getByText('Tap me'))
			expect(mockNavigate).toHaveBeenCalledWith({
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId: 'ws-1', objectId: 'obj-7' },
			})
		})
	})
})
