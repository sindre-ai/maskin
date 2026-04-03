import { getDynamicColumns } from '@/components/objects/data-table/dynamic-columns'
import type { ObjectResponse } from '@/lib/api'
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'

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

describe('getDynamicColumns', () => {
	it('returns empty array when fieldDefinitions is undefined', () => {
		expect(getDynamicColumns(undefined)).toEqual([])
	})

	it('returns empty array when fieldDefinitions is an empty object', () => {
		expect(getDynamicColumns({})).toEqual([])
	})

	it('returns columns for all types when no typeFilter', () => {
		const fields = {
			bet: [{ name: 'priority', type: 'text' as const }],
			task: [{ name: 'effort', type: 'number' as const }],
		}
		const columns = getDynamicColumns(fields)
		expect(columns).toHaveLength(2)
		expect(columns[0].id).toBe('metadata.priority')
		expect(columns[1].id).toBe('metadata.effort')
	})

	it('filters columns by typeFilter', () => {
		const fields = {
			bet: [{ name: 'priority', type: 'text' as const }],
			task: [{ name: 'effort', type: 'number' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		expect(columns).toHaveLength(1)
		expect(columns[0].id).toBe('metadata.priority')
	})

	it('returns empty array for unknown typeFilter', () => {
		const fields = {
			bet: [{ name: 'priority', type: 'text' as const }],
		}
		expect(getDynamicColumns(fields, 'insight')).toEqual([])
	})

	it('deduplicates fields across types when no typeFilter', () => {
		const fields = {
			bet: [{ name: 'priority', type: 'text' as const }],
			task: [{ name: 'priority', type: 'text' as const }],
		}
		const columns = getDynamicColumns(fields)
		expect(columns).toHaveLength(1)
		expect(columns[0].id).toBe('metadata.priority')
	})

	it('renders dash for null metadata value', () => {
		const fields = {
			bet: [{ name: 'priority', type: 'text' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		const data = [buildObjectResponse({ metadata: { priority: null } })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('—')).toBeInTheDocument()
	})

	it('renders dash for missing metadata key', () => {
		const fields = {
			bet: [{ name: 'priority', type: 'text' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		const data = [buildObjectResponse({ metadata: {} })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('—')).toBeInTheDocument()
	})

	it('renders "Yes" for boolean true', () => {
		const fields = {
			bet: [{ name: 'approved', type: 'boolean' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		const data = [buildObjectResponse({ metadata: { approved: true } })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('Yes')).toBeInTheDocument()
	})

	it('renders "No" for boolean false', () => {
		const fields = {
			bet: [{ name: 'approved', type: 'boolean' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		const data = [buildObjectResponse({ metadata: { approved: false } })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('No')).toBeInTheDocument()
	})

	it('renders number as string', () => {
		const fields = {
			bet: [{ name: 'score', type: 'number' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		const data = [buildObjectResponse({ metadata: { score: 42 } })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('42')).toBeInTheDocument()
	})

	it('renders date field as RelativeTime', () => {
		const fields = {
			bet: [{ name: 'deadline', type: 'date' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		const data = [buildObjectResponse({ metadata: { deadline: '2026-01-01T00:00:00Z' } })]
		render(<TestTable data={data} columns={columns} />)
		const timeEl = screen.getByRole('cell').querySelector('time')
		expect(timeEl).toBeInTheDocument()
		expect(timeEl?.getAttribute('dateTime')).toBe('2026-01-01T00:00:00Z')
	})

	it('renders text field as string', () => {
		const fields = {
			bet: [{ name: 'category', type: 'text' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		const data = [buildObjectResponse({ metadata: { category: 'growth' } })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByText('growth')).toBeInTheDocument()
	})

	it('replaces underscores with spaces in header label', () => {
		const fields = {
			bet: [{ name: 'due_date', type: 'text' as const }],
		}
		const columns = getDynamicColumns(fields, 'bet')
		const data = [buildObjectResponse({ metadata: { due_date: 'soon' } })]
		render(<TestTable data={data} columns={columns} />)
		expect(screen.getByRole('button', { name: /due date/i })).toBeInTheDocument()
	})
})
