import { getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable } from '@/components/objects/data-table/data-table'
import type { RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { ButtonHTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => vi.fn(),
	Link: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
		const { to: _to, params: _params, onClick, ...rest } = props
		return (
			<button
				type="button"
				{...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
				onClick={(e) => {
					if (typeof onClick === 'function') {
						;(onClick as (ev: ReactMouseEvent<HTMLButtonElement>) => void)(e)
					}
					e.preventDefault()
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

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))

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

globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

const columns = getStaticColumns({ workspaceId: 'ws-1' })

function GroupedTableHarness({
	data,
}: {
	data: ReturnType<typeof buildObjectResponse>[]
}) {
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
	// Fresh grouping array on every render — mirrors the parent route, which
	// is what makes the bug observable: TanStack's getGroupedRowModel memo
	// sees a new reference and (without autoResetExpanded: false) collapses
	// the expanded state whenever rowSelection updates.
	const grouping = ['createdAt']
	return (
		<DataTable
			data={data}
			columns={columns}
			workspaceId="ws-1"
			rowSelection={rowSelection}
			onRowSelectionChange={setRowSelection}
			columnVisibility={{} as VisibilityState}
			onColumnVisibilityChange={vi.fn()}
			grouping={grouping}
		/>
	)
}

describe('DataTable grouped selection', () => {
	it('keeps the group expanded when a row inside is selected', async () => {
		const user = userEvent.setup()
		const data = [
			buildObjectResponse({ id: 'a', title: 'Alpha', createdAt: '2026-06-01T08:00:00Z' }),
			buildObjectResponse({ id: 'b', title: 'Beta', createdAt: '2026-06-01T09:00:00Z' }),
		]
		render(<GroupedTableHarness data={data} />)

		// Group header renders the formatted date (see formatGroupDate in data-table.tsx).
		const groupHeader = screen.getByText('1st June 2026')
		// Children start collapsed.
		expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

		await user.click(groupHeader)
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()

		const [firstRowCheckbox] = screen.getAllByRole('checkbox', { name: 'Select row' })
		await user.click(firstRowCheckbox)

		// Regression guard: selecting a row must not collapse its parent group.
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()
	})
})
