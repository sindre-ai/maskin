import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { useIsMobile } from '@/hooks/use-mobile'
import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { Link, useNavigate } from '@tanstack/react-router'
import {
	type Column,
	type ColumnDef,
	type SortingState,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	useReactTable,
} from '@tanstack/react-table'
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { SortableHeader } from './data-table/columns'

export interface ResolvedRelationship {
	rel: RelationshipResponse
	object: ObjectResponse
}

interface RelatedObjectsTableProps {
	rows: ResolvedRelationship[]
	workspaceId: string
	onDeleteRelationship: (relationshipId: string) => void
	onNavigate?: (workspaceId: string, objectId: string) => void
}

function ColumnSortHeader({
	label,
	column,
}: {
	label: string
	column: Column<ResolvedRelationship>
}) {
	const sorted = column.getIsSorted()
	return (
		<SortableHeader
			label={label}
			columnId={column.id}
			currentSort={sorted ? column.id : undefined}
			currentOrder={sorted === 'asc' ? 'asc' : 'desc'}
			onSort={() => column.toggleSorting()}
		/>
	)
}

export function RelatedObjectsTable({
	rows,
	workspaceId,
	onDeleteRelationship,
	onNavigate,
}: RelatedObjectsTableProps) {
	const navigate = useNavigate()
	const isMobile = useIsMobile()
	const [sorting, setSorting] = useState<SortingState>([])

	const columns = useMemo<ColumnDef<ResolvedRelationship>[]>(
		() => [
			{
				id: 'title',
				accessorFn: (row) => row.object.title ?? '',
				header: ({ column }) => <ColumnSortHeader label="Title" column={column} />,
				cell: ({ row }) => {
					const obj = row.original.object
					return (
						<div className="flex items-center gap-2">
							<Link
								to="/$workspaceId/objects/$objectId"
								params={{ workspaceId, objectId: obj.id }}
								className="font-medium truncate max-w-[150px] sm:max-w-[300px] text-foreground hover:underline"
								onClick={(e) => e.stopPropagation()}
							>
								{obj.title || 'Untitled'}
							</Link>
							{obj.activeSessionId && (
								<AgentWorkingBadge sessionId={obj.activeSessionId} workspaceId={workspaceId} />
							)}
						</div>
					)
				},
			},
			{
				id: 'relationship',
				accessorFn: (row) => row.rel.type,
				header: ({ column }) => <ColumnSortHeader label="Relationship" column={column} />,
				cell: ({ row }) => (
					<Badge variant="outline" className="text-[10px] font-normal">
						{row.original.rel.type.replace(/_/g, ' ')}
					</Badge>
				),
			},
			{
				id: 'status',
				accessorFn: (row) => row.object.status,
				header: ({ column }) => <ColumnSortHeader label="Status" column={column} />,
				cell: ({ row }) => <StatusBadge status={row.original.object.status} />,
			},
			{
				id: 'type',
				accessorFn: (row) => row.object.type,
				header: ({ column }) => <ColumnSortHeader label="Type" column={column} />,
				cell: ({ row }) => <TypeBadge type={row.original.object.type} />,
			},
			{
				id: 'actions',
				header: '',
				cell: ({ row }) => (
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 text-muted-foreground hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
						onClick={(e) => {
							e.stopPropagation()
							onDeleteRelationship(row.original.rel.id)
						}}
						title="Remove link"
					>
						<X className="h-3 w-3" />
					</Button>
				),
				enableSorting: false,
				size: 40,
			},
		],
		[workspaceId, onDeleteRelationship],
	)

	const table = useReactTable({
		data: rows,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: (row) => row.rel.id,
	})

	const handleRowClick = (objectId: string) => {
		if (onNavigate) {
			onNavigate(workspaceId, objectId)
		} else {
			navigate({
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId, objectId },
			})
		}
	}

	if (isMobile) {
		return (
			<ul aria-label="Related objects" className="m-0 max-h-[28rem] list-none overflow-auto p-0">
				{table.getRowModel().rows.map((row) => (
					<RelatedObjectCard
						key={row.id}
						resolved={row.original}
						workspaceId={workspaceId}
						onClick={() => handleRowClick(row.original.object.id)}
						onDelete={() => onDeleteRelationship(row.original.rel.id)}
					/>
				))}
			</ul>
		)
	}

	return (
		<div className="max-h-[28rem] overflow-auto">
			<Table>
				<TableHeader className="[&_tr]:border-b-0">
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow key={headerGroup.id} className="hover:bg-transparent">
							{headerGroup.headers.map((header) => (
								<TableHead key={header.id} className="h-8 px-2 sticky top-0 bg-background z-10">
									{header.isPlaceholder
										? null
										: flexRender(header.column.columnDef.header, header.getContext())}
								</TableHead>
							))}
						</TableRow>
					))}
				</TableHeader>
				<TableBody>
					{table.getRowModel().rows.map((row) => (
						<TableRow
							key={row.id}
							className="group cursor-pointer border-b-0"
							onClick={() => handleRowClick(row.original.object.id)}
						>
							{row.getVisibleCells().map((cell) => (
								<TableCell key={cell.id} className="py-1.5 px-2">
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}

function RelatedObjectCard({
	resolved,
	workspaceId,
	onClick,
	onDelete,
}: {
	resolved: ResolvedRelationship
	workspaceId: string
	onClick: () => void
	onDelete: () => void
}) {
	const { rel, object } = resolved
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: card click supplements the inner Link, which keyboard users tab to and activate with Enter
		<li
			onClick={onClick}
			className="flex w-full cursor-pointer items-start gap-3 border-b border-border bg-card px-3 py-3 transition-colors hover:bg-accent/30"
		>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex min-w-0 items-center gap-2">
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: object.id }}
						onClick={(e) => e.stopPropagation()}
						className="truncate text-sm font-medium text-foreground hover:underline"
					>
						{object.title || 'Untitled'}
					</Link>
					{object.activeSessionId && (
						<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
					)}
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<Badge variant="outline" className="text-[10px] font-normal">
						{rel.type.replace(/_/g, ' ')}
					</Badge>
					<TypeBadge type={object.type} />
					<StatusBadge status={object.status} />
				</div>
			</div>
			<Button
				variant="ghost"
				size="icon"
				className="h-7 w-7 shrink-0 text-muted-foreground hover:text-error"
				onClick={(e) => {
					e.stopPropagation()
					onDelete()
				}}
				title="Remove link"
				aria-label="Remove link"
			>
				<X className="h-3 w-3" />
			</Button>
		</li>
	)
}
