import { getStaticColumns } from '@/components/objects/data-table/columns'
import type { ObjectResponse } from '@/lib/api'
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

function TestTable({
	data,
	columns,
	meta,
}: {
	data: ObjectResponse[]
	columns: ColumnDef<ObjectResponse>[]
	meta?: Record<string, unknown>
}) {
	const table = useReactTable({
		data,
		columns,
		meta,
		getCoreRowModel: getCoreRowModel(),
		getRowId: (row) => row.id,
	})

	return (
		<table>
			<thead>
				{table.getHeaderGroups().map((hg) => (
					<tr key={hg.id}>
						{hg.headers.map((header) => (
							<th key={header.id}>
								{header.isPlaceholder
									? null
									: flexRender(header.column.columnDef.header, header.getContext())}
							</th>
						))}
					</tr>
				))}
			</thead>
			<tbody>
				{table.getRowModel().rows.map((row) => (
					<tr key={row.id}>
						{row.getVisibleCells().map((cell) => (
							<td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	)
}

describe('getStaticColumns', () => {
	it('returns 8 columns', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		expect(columns).toHaveLength(8)
	})

	it('renders "Untitled" for null title', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ title: null })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('renders "Untitled" for empty title', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ title: '' })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('shows AgentWorkingBadge when activeSessionId is set', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ activeSessionId: 'session-1' })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('agent working')).toBeInTheDocument()
	})

	it('does not show AgentWorkingBadge when activeSessionId is null', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ activeSessionId: null })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.queryByText('agent working')).not.toBeInTheDocument()
	})

	it('renders StatusBadge for status column', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ status: 'active' })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('active')).toBeInTheDocument()
	})

	it('renders TypeBadge for type column', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ type: 'bet' })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('bet')).toBeInTheDocument()
	})

	it('shows actor name for owner column', () => {
		const columns = getStaticColumns({
			workspaceId: 'ws-1',
			actors: [
				{
					id: 'actor-1',
					name: 'Alice',
					type: 'human',
					email: null,
					description: null,
					isSystem: false,
					agentState: 'idle' as const,
				},
				{
					id: 'actor-2',
					name: 'Bob',
					type: 'human',
					email: null,
					description: null,
					isSystem: false,
					agentState: 'idle' as const,
				},
			],
		})
		const data = [buildObjectResponse({ driver: 'actor-2', createdBy: 'actor-1' })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('Bob')).toBeInTheDocument()
	})

	it('shows dash when owner is null', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ driver: null })]
		render(<TestTable data={data} columns={columns} />)
		// Owner cell renders a dash character
		const dashes = screen.getAllByText('—')
		expect(dashes.length).toBeGreaterThan(0)
	})

	it('calls onSort when sortable header is clicked', async () => {
		const user = userEvent.setup()
		const onSort = vi.fn()
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const meta = { onSort, currentSort: 'createdAt', currentOrder: 'desc' }
		const data = [buildObjectResponse()]
		render(<TestTable data={data} columns={columns} meta={meta} />)

		await user.click(screen.getByRole('button', { name: /title/i }))
		expect(onSort).toHaveBeenCalledWith('title')
	})

	// iOS HIG requires a 44×44pt minimum tap target. jsdom doesn't run Tailwind so we
	// assert on the sizing classes rather than computed pixels — `min-h-11` / `min-w-11`
	// resolve to 44px at the default root font size.
	it('wraps header + row checkboxes in a ≥44px tap target', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse()]
		render(<TestTable data={data} columns={columns} />)

		const headerTarget = screen.getByTestId('select-all-tap-target')
		const rowTarget = screen.getByTestId('select-row-tap-target')

		for (const target of [headerTarget, rowTarget]) {
			expect(target.className).toMatch(/min-h-11/)
			expect(target.className).toMatch(/min-w-11/)
		}
	})

	it('tap target click does not bubble to ancestor row handler', async () => {
		const user = userEvent.setup()
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ id: 'row-1' })]
		const rowClick = vi.fn()

		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents: test scaffold for click propagation
			<div onClick={rowClick}>
				<TestTable data={data} columns={columns} />
			</div>,
		)

		await user.click(screen.getByTestId('select-row-tap-target'))
		expect(rowClick).not.toHaveBeenCalled()
	})
})
