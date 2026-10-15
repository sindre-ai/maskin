import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
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
import type { GraphFileSummary, ObjectResponse, RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
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
import { MimeTile, formatBytes } from './file-tile'

/** A row in the Related table is either an object endpoint or a file
 *  endpoint. Discriminated on `kind` so the render branch stays type-safe
 *  without prop drilling. */
export type ResolvedRow =
	| { kind: 'object'; rel: RelationshipResponse; object: ObjectResponse }
	| { kind: 'file'; rel: RelationshipResponse; file: GraphFileSummary }

/** Back-compat alias. Some sibling code + tests import `ResolvedRelationship`
 *  from this module — keep the object-only variant available under the old
 *  name so nothing has to change on Slice 1's blast radius. */
export type ResolvedRelationship = Extract<ResolvedRow, { kind: 'object' }>

interface RelatedObjectsTableProps {
	rows: ResolvedRow[]
	workspaceId: string
	onDeleteRelationship: (relationshipId: string) => void
	onNavigate?: (workspaceId: string, objectId: string) => void
	/** Show a "when" column with the linked object's updatedAt (falls back to
	 *  createdAt). Off by default so existing callers stay unchanged; the
	 *  Related tab (T4) opts in to satisfy the type/name/status/when contract. */
	showWhen?: boolean
}

function ColumnSortHeader({
	label,
	column,
}: {
	label: string
	column: Column<ResolvedRow>
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

// Accessors defensively branch on kind. A row is a file row iff `kind ===
// 'file'`; any other shape (a legacy `{rel, object}` written before Slice 1
// added the discriminant) falls into the object branch. This keeps every
// existing call site working without a mass rewrite of test fixtures.
function isFileRow(row: ResolvedRow): row is Extract<ResolvedRow, { kind: 'file' }> {
	return row.kind === 'file'
}
function rowTitle(row: ResolvedRow): string {
	return isFileRow(row) ? row.file.name : (row.object?.title ?? '')
}
function rowType(row: ResolvedRow): string {
	return isFileRow(row) ? 'file' : (row.object?.type ?? '')
}
function rowStatus(row: ResolvedRow): string {
	return isFileRow(row) ? '' : (row.object?.status ?? '')
}
function rowWhen(row: ResolvedRow): string {
	if (isFileRow(row)) return ''
	return row.object?.updatedAt ?? row.object?.createdAt ?? ''
}

export function RelatedObjectsTable({
	rows,
	workspaceId,
	onDeleteRelationship,
	onNavigate,
	showWhen = false,
}: RelatedObjectsTableProps) {
	const navigate = useNavigate()
	const isMobile = useIsMobile()
	const [sorting, setSorting] = useState<SortingState>([])

	const columns = useMemo<ColumnDef<ResolvedRow>[]>(() => {
		const cols: ColumnDef<ResolvedRow>[] = [
			{
				id: 'title',
				accessorFn: rowTitle,
				header: ({ column }) => <ColumnSortHeader label="Title" column={column} />,
				cell: ({ row }) => {
					const item = row.original
					if (isFileRow(item)) {
						// FileRow shape (Designer §4): 32×32 mime tile + filename +
						// mime/size mono meta. Tile is aria-hidden; the filename to
						// its right carries the accessible name.
						return (
							<div className="flex items-center gap-2 min-w-0">
								<MimeTile mimeType={item.file.mimeType} size="md" />
								<a
									href={item.file.url}
									target="_blank"
									rel="noreferrer"
									onClick={(e) => e.stopPropagation()}
									className="flex min-w-0 flex-1 flex-col text-left"
								>
									<span className="truncate text-[13.5px] font-medium text-foreground hover:underline">
										{item.file.name}
									</span>
									<span className="truncate font-mono text-[10.5px] text-muted-foreground">
										{item.file.mimeType} · {formatBytes(item.file.sizeBytes)}
									</span>
								</a>
							</div>
						)
					}
					const obj = item.object
					return (
						<div className="flex items-center gap-2 min-w-0">
							<Link
								to="/$workspaceId/objects/$objectId"
								params={{ workspaceId, objectId: obj.id }}
								className="font-medium truncate min-w-0 flex-1 text-foreground hover:underline"
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
				accessorFn: rowStatus,
				header: ({ column }) => <ColumnSortHeader label="Status" column={column} />,
				cell: ({ row }) =>
					isFileRow(row.original) ? (
						// Files don't carry a status; keep the column present for
						// object rows so the table layout stays consistent.
						<span className="text-xs text-muted-foreground" aria-label="No status">
							—
						</span>
					) : (
						<StatusBadge status={row.original.object?.status ?? ''} />
					),
			},
			{
				id: 'type',
				accessorFn: rowType,
				header: ({ column }) => <ColumnSortHeader label="Type" column={column} />,
				cell: ({ row }) => <TypeBadge type={rowType(row.original)} />,
			},
		]
		if (showWhen) {
			cols.push({
				id: 'when',
				accessorFn: rowWhen,
				header: ({ column }) => <ColumnSortHeader label="When" column={column} />,
				cell: ({ row }) => {
					const when = rowWhen(row.original)
					return (
						<span className="text-xs text-muted-foreground tabular-nums">
							{when ? <RelativeTime date={when} /> : null}
						</span>
					)
				},
			})
		}
		cols.push({
			id: 'actions',
			header: '',
			cell: ({ row }) => (
				<Button
					variant="ghost"
					size="icon"
					/* Always visible on touch; fades behind row hover on sm+. */
					className="h-7 w-7 text-muted-foreground hover:text-error opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
					onClick={(e) => {
						e.stopPropagation()
						onDeleteRelationship(row.original.rel.id)
					}}
					title="Remove link"
					aria-label="Remove link"
				>
					<X className="h-3 w-3" />
				</Button>
			),
			enableSorting: false,
			size: 40,
		})
		return cols
	}, [workspaceId, onDeleteRelationship, showWhen])

	const table = useReactTable({
		data: rows,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: (row) => row.rel.id,
	})

	const handleRowClick = (row: ResolvedRow) => {
		if (isFileRow(row)) {
			// A file row's implicit action is to open the file's viewer URL —
			// the header link handles the accessible path; here we mirror the
			// object row's whole-row click affordance.
			window.open(row.file.url, '_blank', 'noopener,noreferrer')
			return
		}
		if (onNavigate) {
			onNavigate(workspaceId, row.object.id)
		} else {
			navigate({
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId, objectId: row.object.id },
			})
		}
	}

	if (isMobile) {
		return (
			<ul aria-label="Related objects" className="m-0 max-h-[28rem] list-none overflow-auto p-0">
				{table.getRowModel().rows.map((row) => (
					<RelatedRowCard
						key={row.id}
						resolved={row.original}
						workspaceId={workspaceId}
						onClick={() => handleRowClick(row.original)}
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
								<TableHead
									key={header.id}
									className={cn(
										'h-8 px-2 sticky top-0 bg-background z-10',
										header.column.id === 'title' && 'w-full',
									)}
								>
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
							className="group cursor-pointer border-b-0 hover:bg-muted"
							onClick={() => handleRowClick(row.original)}
						>
							{row.getVisibleCells().map((cell) => (
								<TableCell
									key={cell.id}
									className={cn('py-1.5 px-2', cell.column.id === 'title' && 'max-w-0')}
								>
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

function RelatedRowCard({
	resolved,
	workspaceId,
	onClick,
	onDelete,
}: {
	resolved: ResolvedRow
	workspaceId: string
	onClick: () => void
	onDelete: () => void
}) {
	if (isFileRow(resolved)) {
		return (
			// biome-ignore lint/a11y/useKeyWithClickEvents: card click supplements the inner link, which keyboard users reach via Tab
			<li
				onClick={onClick}
				className="flex w-full cursor-pointer items-start gap-3 border-b border-border bg-card px-3 py-3 transition-colors hover:bg-accent/30"
			>
				<MimeTile mimeType={resolved.file.mimeType} size="md" />
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<a
						href={resolved.file.url}
						target="_blank"
						rel="noreferrer"
						onClick={(e) => e.stopPropagation()}
						className="truncate text-sm font-medium text-foreground hover:underline"
					>
						{resolved.file.name}
					</a>
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<Badge variant="outline" className="text-[10px] font-normal">
							{resolved.rel.type.replace(/_/g, ' ')}
						</Badge>
						<TypeBadge type="file" />
						<span className="font-mono text-[10.5px] text-muted-foreground">
							{resolved.file.mimeType} · {formatBytes(resolved.file.sizeBytes)}
						</span>
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
