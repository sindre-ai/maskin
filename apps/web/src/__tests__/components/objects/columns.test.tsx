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
}: { data: ObjectResponse[]; columns: ColumnDef<ObjectResponse>[] }) {
	const table = useReactTable({
		data,
		columns,
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
				{ id: 'actor-1', name: 'Alice' },
				{ id: 'actor-2', name: 'Bob' },
			],
		})
		const data = [buildObjectResponse({ owner: 'actor-2', createdBy: 'actor-1' })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('Bob')).toBeInTheDocument()
	})

	it('shows dash when owner is null', () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const data = [buildObjectResponse({ owner: null })]
		render(<TestTable data={data} columns={columns} />)
		// Owner cell renders a dash character
		const dashes = screen.getAllByText('—')
		expect(dashes.length).toBeGreaterThan(0)
	})

	it('calls onSort when sortable header is clicked', async () => {
		const user = userEvent.setup()
		const onSort = vi.fn()
		const columns = getStaticColumns({
			workspaceId: 'ws-1',
			onSort,
			currentSort: 'createdAt',
			currentOrder: 'desc',
		})
		const data = [buildObjectResponse()]
		render(<TestTable data={data} columns={columns} />)

		await user.click(screen.getByRole('button', { name: /title/i }))
		expect(onSort).toHaveBeenCalledWith('title')
	})
})
