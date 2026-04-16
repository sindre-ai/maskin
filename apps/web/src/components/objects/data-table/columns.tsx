import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Checkbox } from '@/components/ui/checkbox'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import type { ColumnDef, Table } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

/** Sort state passed via table.options.meta to avoid re-creating columns on every sort change */
export interface ObjectsTableMeta {
	[key: string]: unknown
	onSort: (columnId: string) => void
	currentSort: string
	currentOrder: 'asc' | 'desc'
}

interface ColumnOptions {
	workspaceId: string
	actors?: ActorListItem[]
}

export function SortableHeader({
	label,
	columnId,
	currentSort,
	currentOrder,
	onSort,
}: {
	label: string
	columnId: string
	currentSort?: string
	currentOrder?: 'asc' | 'desc'
	onSort?: (columnId: string) => void
}) {
	const isActive = currentSort === columnId
	return (
		<button
			type="button"
			className={cn(
				'flex items-center gap-1 hover:text-foreground transition-colors -ml-2 px-2 py-1 rounded',
				isActive ? 'text-foreground' : 'text-muted-foreground',
			)}
			onClick={() => onSort?.(columnId)}
		>
			{label}
			{isActive ? (
				currentOrder === 'asc' ? (
					<ArrowUp size={14} />
				) : (
					<ArrowDown size={14} />
				)
			) : (
				<ArrowUpDown size={14} className="opacity-50" />
			)}
		</button>
	)
}

function sortableHeader(label: string, columnId: string) {
	return ({ table }: { table: Table<ObjectResponse> }) => {
		const meta = table.options.meta as ObjectsTableMeta | undefined
		return (
			<SortableHeader
				label={label}
				columnId={columnId}
				currentSort={meta?.currentSort}
				currentOrder={meta?.currentOrder}
				onSort={meta?.onSort}
			/>
		)
	}
}

export function getStaticColumns(options: ColumnOptions): ColumnDef<ObjectResponse>[] {
	const { workspaceId, actors } = options

	return [
		{
			id: 'select',
			header: ({ table }) => (
				<Checkbox
					checked={
						table.getIsAllPageRowsSelected() ||
						(table.getIsSomePageRowsSelected() && 'indeterminate')
					}
					onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
					aria-label="Select all"
				/>
			),
			cell: ({ row }) => (
				<Checkbox
					checked={row.getIsSelected()}
					onCheckedChange={(value) => row.toggleSelected(!!value)}
					aria-label="Select row"
					onClick={(e) => e.stopPropagation()}
				/>
			),
			enableSorting: false,
			enableHiding: false,
			size: 40,
		},
		{
			accessorKey: 'title',
			header: sortableHeader('Title', 'title'),
			cell: ({ row }) => (
				<div className="flex items-center gap-2">
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: row.original.id }}
						className="font-medium truncate max-w-[300px] text-foreground hover:underline"
						onClick={(e) => e.stopPropagation()}
					>
						{row.getValue('title') || 'Untitled'}
					</Link>
					{row.original.activeSessionId && (
						<AgentWorkingBadge sessionId={row.original.activeSessionId} workspaceId={workspaceId} />
					)}
				</div>
			),
			enableHiding: false,
		},
		{
			accessorKey: 'status',
			header: sortableHeader('Status', 'status'),
			cell: ({ row }) => <StatusBadge status={row.getValue('status')} />,
		},
		{
			accessorKey: 'type',
			header: 'Type',
			cell: ({ row }) => <TypeBadge type={row.getValue('type')} />,
			enableSorting: false,
		},
		{
			accessorKey: 'owner',
			header: 'Owner',
			cell: ({ row }) => {
				const ownerId = row.getValue('owner') as string | null
				if (!ownerId) return <span className="text-muted-foreground">—</span>
				const actor = actors?.find((a) => a.id === ownerId)
				return <span className="text-sm">{actor?.name ?? '—'}</span>
			},
			enableSorting: false,
		},
		{
			accessorKey: 'createdBy',
			header: 'Created by',
			cell: ({ row }) => {
				const createdById = row.getValue('createdBy') as string
				const actor = actors?.find((a) => a.id === createdById)
				return <span className="text-sm">{actor?.name ?? '—'}</span>
			},
			enableSorting: false,
		},
		{
			accessorKey: 'createdAt',
			header: sortableHeader('Created', 'createdAt'),
			cell: ({ row }) => (
				<RelativeTime date={row.getValue('createdAt')} className="text-sm text-muted-foreground" />
			),
		},
		{
			accessorKey: 'updatedAt',
			header: sortableHeader('Updated', 'updatedAt'),
			cell: ({ row }) => (
				<RelativeTime date={row.getValue('updatedAt')} className="text-sm text-muted-foreground" />
			),
		},
	]
}
