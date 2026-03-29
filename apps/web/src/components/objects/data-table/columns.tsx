import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Checkbox } from '@/components/ui/checkbox'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

interface ColumnOptions {
	workspaceId: string
	actors?: Array<{ id: string; name: string }>
	onSort?: (columnId: string) => void
	currentSort?: string
	currentOrder?: 'asc' | 'desc'
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

export function getStaticColumns(options: ColumnOptions): ColumnDef<ObjectResponse>[] {
	const { workspaceId, actors, onSort, currentSort, currentOrder } = options

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
			header: () => (
				<SortableHeader
					label="Title"
					columnId="title"
					currentSort={currentSort}
					currentOrder={currentOrder}
					onSort={onSort}
				/>
			),
			cell: ({ row }) => (
				<div className="flex items-center gap-2">
					<span className="font-medium truncate max-w-[300px]">
						{row.getValue('title') || 'Untitled'}
					</span>
					{row.original.activeSessionId && (
						<AgentWorkingBadge sessionId={row.original.activeSessionId} workspaceId={workspaceId} />
					)}
				</div>
			),
			enableHiding: false,
		},
		{
			accessorKey: 'status',
			header: () => (
				<SortableHeader
					label="Status"
					columnId="status"
					currentSort={currentSort}
					currentOrder={currentOrder}
					onSort={onSort}
				/>
			),
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
			header: () => (
				<SortableHeader
					label="Created"
					columnId="createdAt"
					currentSort={currentSort}
					currentOrder={currentOrder}
					onSort={onSort}
				/>
			),
			cell: ({ row }) => (
				<RelativeTime date={row.getValue('createdAt')} className="text-sm text-muted-foreground" />
			),
		},
		{
			accessorKey: 'updatedAt',
			header: () => (
				<SortableHeader
					label="Updated"
					columnId="updatedAt"
					currentSort={currentSort}
					currentOrder={currentOrder}
					onSort={onSort}
				/>
			),
			cell: ({ row }) => (
				<RelativeTime date={row.getValue('updatedAt')} className="text-sm text-muted-foreground" />
			),
		},
	]
}
