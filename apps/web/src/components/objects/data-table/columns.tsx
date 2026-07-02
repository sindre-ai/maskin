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

/**
 * Expands a small visual control's hit zone to 44×44 (iOS HIG minimum) via a
 * centered, transparent `::before` pseudo-element. The visual size of the
 * control is unchanged — only the touchable area grows.
 */
const TAP_TARGET_44 =
	"relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"

/** Returns a YYYY-MM-DD string for grouping by day */
function toDateKey(iso: string | null | undefined): string {
	if (!iso) return ''
	const d = new Date(iso)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
					className={TAP_TARGET_44}
				/>
			),
			cell: ({ row }) => (
				<span
					data-drag-checkbox=""
					className="inline-flex touch-none select-none items-center justify-center"
				>
					<Checkbox
						checked={row.getIsSelected()}
						onCheckedChange={(value) => row.toggleSelected(!!value)}
						aria-label="Select row"
						onClick={(e) => e.stopPropagation()}
						className={TAP_TARGET_44}
					/>
				</span>
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
						className="font-medium truncate max-w-[150px] sm:max-w-[300px] text-foreground hover:underline"
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
			accessorKey: 'driver',
			header: 'Driver',
			cell: ({ row }) => {
				const driverId = row.getValue('driver') as string | null
				if (!driverId) return <span className="text-muted-foreground">—</span>
				const actor = actors?.find((a) => a.id === driverId)
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
			getGroupingValue: (row) => toDateKey(row.createdAt),
		},
		{
			accessorKey: 'updatedAt',
			header: sortableHeader('Updated', 'updatedAt'),
			cell: ({ row }) => (
				<RelativeTime date={row.getValue('updatedAt')} className="text-sm text-muted-foreground" />
			),
			getGroupingValue: (row) => toDateKey(row.updatedAt),
		},
	]
}
