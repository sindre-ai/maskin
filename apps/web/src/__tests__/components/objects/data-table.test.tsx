import { getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable, type DataTableHandle } from '@/components/objects/data-table/data-table'
import type {
	ExpandedState,
	OnChangeFn,
	RowSelectionState,
	VisibilityState,
} from '@tanstack/react-table'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
	type ButtonHTMLAttributes,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	createRef,
	useState,
} from 'react'
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

// Wraps DataTable so header-chevron clicks in tests visibly toggle expansion
// via the controlled onExpandedChange boundary. Production wiring lives in
// the Objects route; this harness just keeps the primitive testable.
function StatefulExpandedHarness(props: Parameters<typeof DataTable>[0]) {
	const [expanded, setExpanded] = useState<ExpandedState>(props.expanded)
	const onExpandedChange: OnChangeFn<ExpandedState> = (updater) => {
		setExpanded((prev) => (typeof updater === 'function' ? updater(prev) : updater))
		props.onExpandedChange(updater)
	}
	return <DataTable {...props} expanded={expanded} onExpandedChange={onExpandedChange} />
}

function renderDataTable(overrides: Partial<Parameters<typeof DataTable>[0]> = {}) {
	const props = {
		data: [],
		columns: defaultColumns,
		workspaceId: 'ws-1',
		rowSelection: {} as RowSelectionState,
		onRowSelectionChange: vi.fn(),
		columnVisibility: {} as VisibilityState,
		onColumnVisibilityChange: vi.fn(),
		expanded: {} as ExpandedState,
		onExpandedChange: vi.fn(),
		...overrides,
	}
	return render(<StatefulExpandedHarness {...props} />)
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

	it('calls onCaptureViewState synchronously before navigating on row click', async () => {
		const user = userEvent.setup()
		const onCaptureViewState = vi.fn()
		const obj = buildObjectResponse({
			id: 'obj-99',
			title: 'Anchor row',
			status: 'active',
		})
		const { container } = renderDataTable({ data: [obj], onCaptureViewState })

		// Click on the row (not the title Link — that stops propagation to keep
		// keyboard-select semantics clean). The row-level onClick calls the
		// route's `handleRowClick`, which is what wires the capture callback.
		const row = container.querySelector('tr[data-drag-row]') as HTMLElement | null
		expect(row).not.toBeNull()
		await user.click(row as HTMLElement)

		// Capture must run before navigate so the store holds the outgoing
		// scroll anchor by the time the router pushes the detail route.
		expect(onCaptureViewState).toHaveBeenCalledTimes(1)
		const captureOrder = onCaptureViewState.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
		const navigateOrder = mockNavigate.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY
		expect(captureOrder).toBeLessThan(navigateOrder)
	})

	it('exposes an imperative handle whose getFirstVisibleRowId returns the top virtualized row id', () => {
		const ref = createRef<DataTableHandle>()
		const data = [
			buildObjectResponse({ id: 'row-top', title: 'Top' }),
			buildObjectResponse({ id: 'row-2', title: 'Second' }),
		]
		render(
			<DataTable
				ref={ref}
				data={data}
				columns={defaultColumns}
				workspaceId="ws-1"
				rowSelection={{}}
				onRowSelectionChange={vi.fn()}
				columnVisibility={{}}
				onColumnVisibilityChange={vi.fn()}
				expanded={{}}
				onExpandedChange={vi.fn()}
			/>,
		)
		expect(ref.current).not.toBeNull()
		expect(ref.current?.getFirstVisibleRowId()).toBe('row-top')
	})

	it('shows fetching indicator when isFetchingNextPage is true', () => {
		const data = [buildObjectResponse({ title: 'Some Object' })]
		renderDataTable({ data, isFetchingNextPage: true })
		// The main table plus a loading spinner for pagination
		const spinners = screen.getAllByTitle('Loading')
		expect(spinners.length).toBeGreaterThanOrEqual(1)
	})

	it('marks archived rows with data-archived and the dimmed opacity class (desktop)', () => {
		const data = [
			buildObjectResponse({
				id: 'archived-1',
				title: 'Old bet',
				status: 'archived',
				metadata: { previous_status: 'succeeded' },
			}),
			buildObjectResponse({ id: 'active-1', title: 'Live bet', status: 'active' }),
		]
		const { container } = renderDataTable({ data })
		const archivedRow = container.querySelector('tr[data-archived]') as HTMLElement | null
		expect(archivedRow).not.toBeNull()
		expect(archivedRow?.className).toMatch(/opacity-\[0.62\]/)
		// Active row must not carry the archived attribute or the dim class.
		const rows = container.querySelectorAll('tbody tr')
		const activeRow = Array.from(rows).find((r) => r.textContent?.includes('Live bet'))
		expect(activeRow?.hasAttribute('data-archived')).toBe(false)
		expect(activeRow?.className ?? '').not.toMatch(/opacity-\[0.62\]/)
	})

	it('lets the Title column expand to fill remaining width', () => {
		const data = [buildObjectResponse({ title: 'Wide Object' })]
		renderDataTable({ data })

		const titleHeader = screen.getByRole('columnheader', { name: /title/i })
		expect(titleHeader.className).toMatch(/\bw-full\b/)

		const titleCell = screen.getByText('Wide Object').closest('td')
		expect(titleCell?.className).toMatch(/\bmax-w-0\b/)

		const otherHeader = screen.getByRole('columnheader', { name: /^status$/i })
		expect(otherHeader.className).not.toMatch(/\bw-full\b/)
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
				expanded: {} as ExpandedState,
				onExpandedChange: vi.fn(),
			}
			const { rerender } = render(<StatefulExpandedHarness {...props} />)

			await user.click(screen.getByRole('button', { name: /\(2\)/ }))
			expect(screen.getByText('Gamma')).toBeInTheDocument()

			// Simulate a parent re-render (e.g. closing the left nav) that passes
			// through a fresh data reference. Without autoResetExpanded: false,
			// TanStack Table would collapse the group on this cycle.
			await act(async () => {
				rerender(<StatefulExpandedHarness {...props} data={[...data]} />)
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

		// Mobile card layout renders alongside the desktop table cell, but reads
		// its bet indicator from the same `meta.betStatuses` map. Without this
		// the row indicator is invisible on mobile even though it renders on the
		// data-table cell at md+ viewports.
		it('renders the bet status indicator on a bet card', () => {
			const bet = buildObjectResponse({ id: 'bet-mobile', title: 'Bet Mobile', type: 'bet' })
			const betStatuses = new Map([
				[
					'bet-mobile',
					{ state: 'waiting_on_human' as const, pendingAction: null, decisionsSoFar: [] },
				],
			])
			renderDataTable({
				data: [bet],
				meta: { onSort: vi.fn(), currentSort: 'createdAt', currentOrder: 'desc', betStatuses },
			})
			expect(screen.getByLabelText('Status: waiting')).toBeInTheDocument()
		})

		it('hides the bet status indicator on a bet card when showBetStatusIndicator is false', () => {
			const bet = buildObjectResponse({ id: 'bet-mobile', title: 'Bet Mobile', type: 'bet' })
			const betStatuses = new Map([
				[
					'bet-mobile',
					{ state: 'waiting_on_human' as const, pendingAction: null, decisionsSoFar: [] },
				],
			])
			renderDataTable({
				data: [bet],
				meta: {
					onSort: vi.fn(),
					currentSort: 'createdAt',
					currentOrder: 'desc',
					betStatuses,
					showBetStatusIndicator: false,
				},
			})
			expect(screen.queryByLabelText('Status: waiting')).not.toBeInTheDocument()
		})
	})
})
