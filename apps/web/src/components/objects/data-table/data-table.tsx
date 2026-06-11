import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'

const DATE_GROUP_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
]

function formatGroupDate(dateKey: string): string {
	if (!DATE_GROUP_RE.test(dateKey)) return dateKey
	const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number]
	const suffix =
		d % 10 === 1 && d !== 11
			? 'st'
			: d % 10 === 2 && d !== 12
				? 'nd'
				: d % 10 === 3 && d !== 13
					? 'rd'
					: 'th'
	return `${d}${suffix} ${MONTHS[m - 1]} ${y}`
}

function resolveGroupLabel(
	groupingColumn: string | undefined,
	rawValue: string,
	actors: ActorListItem[] | undefined,
): string {
	if (groupingColumn === 'owner' || groupingColumn === 'createdBy') {
		return actors?.find((a) => a.id === rawValue)?.name ?? rawValue
	}
	return formatGroupDate(rawValue)
}
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { useActors } from '@/hooks/use-actors'
import { useIsMobile } from '@/hooks/use-mobile'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useNavigate } from '@tanstack/react-router'
import {
	type ColumnDef,
	type GroupingState,
	type OnChangeFn,
	type RowSelectionState,
	type VisibilityState,
	flexRender,
	getCoreRowModel,
	getExpandedRowModel,
	getGroupedRowModel,
	useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import type { ObjectsTableMeta } from './columns'
import { ObjectCard } from './object-card'

interface DataTableProps {
	data: ObjectResponse[]
	columns: ColumnDef<ObjectResponse>[]
	workspaceId: string
	actors?: ActorListItem[]
	rowSelection: RowSelectionState
	onRowSelectionChange: OnChangeFn<RowSelectionState>
	columnVisibility: VisibilityState
	onColumnVisibilityChange: OnChangeFn<VisibilityState>
	grouping?: GroupingState
	meta?: ObjectsTableMeta
	hasNextPage?: boolean
	isFetchingNextPage?: boolean
	isError?: boolean
	fetchNextPage?: () => void
	isLoading?: boolean
}

export function DataTable({
	data,
	columns,
	workspaceId,
	actors: actorsProp,
	rowSelection,
	onRowSelectionChange,
	columnVisibility,
	onColumnVisibilityChange,
	grouping,
	meta,
	hasNextPage,
	isFetchingNextPage,
	isError,
	fetchNextPage,
	isLoading,
}: DataTableProps) {
	const navigate = useNavigate()
	const isMobile = useIsMobile()
	const { data: actorsFetched } = useActors(workspaceId, { enabled: isMobile })
	// On mobile, fetch actors locally for the ObjectCard. On desktop, use actors passed from parent.
	const actors = isMobile ? actorsFetched : actorsProp
	const parentRef = useRef<HTMLDivElement>(null)
	const sentinelRef = useRef<HTMLDivElement>(null)

	const table = useReactTable({
		data,
		columns,
		state: {
			rowSelection,
			columnVisibility,
			grouping: grouping ?? [],
		},
		meta: meta as Record<string, unknown>,
		onRowSelectionChange,
		onColumnVisibilityChange,
		getCoreRowModel: getCoreRowModel(),
		getGroupedRowModel: grouping?.length ? getGroupedRowModel() : undefined,
		getExpandedRowModel: grouping?.length ? getExpandedRowModel() : undefined,
		groupedColumnMode: 'remove',
		enableRowSelection: true,
		getRowId: (row) => row.id,
	})

	const { rows } = table.getRowModel()

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => (isMobile ? 96 : 48),
		overscan: isMobile ? 10 : 20,
	})

	// Infinite scroll sentinel — skip when fetching or errored to avoid retry loops
	useEffect(() => {
		if (!sentinelRef.current || !hasNextPage || isFetchingNextPage || isError) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) fetchNextPage?.()
			},
			{ root: parentRef.current, rootMargin: '200px' },
		)
		observer.observe(sentinelRef.current)
		return () => observer.disconnect()
	}, [hasNextPage, isFetchingNextPage, isError, fetchNextPage])

	const handleRowClick = useCallback(
		(objectId: string) => {
			navigate({
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId, objectId },
			})
		},
		[navigate, workspaceId],
	)

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner />
			</div>
		)
	}

	if (data.length === 0) {
		return (
			<EmptyState title="No objects found" description="Create your first object to get started" />
		)
	}

	const virtualItems = virtualizer.getVirtualItems()
	const totalSize = virtualizer.getTotalSize()
	const paddingTop = virtualItems[0]?.start ?? 0
	const paddingBottom = virtualItems.length > 0 ? totalSize - (virtualItems.at(-1)?.end ?? 0) : 0

	if (isMobile) {
		return (
			<div ref={parentRef} className="flex-1 min-h-0 overflow-auto rounded-md border">
				{virtualItems.length === 0 ? (
					<div className="h-24 flex items-center justify-center text-sm text-muted-foreground">
						No results.
					</div>
				) : (
					<ul
						aria-label="Objects"
						className="m-0 list-none p-0"
						style={{ height: totalSize, position: 'relative' }}
					>
						{virtualItems.map((virtualItem) => {
							const row = rows[virtualItem.index]
							if (!row) return null

							const isGrouped = row.getIsGrouped()

							if (isGrouped) {
								const groupingColumn = grouping?.[0]
								const rawValue = String(row.groupingValue)
								const displayValue = resolveGroupLabel(groupingColumn, rawValue, actors)
								return (
									<li
										key={row.id}
										data-index={virtualItem.index}
										ref={virtualizer.measureElement}
										className="absolute left-0 right-0"
										style={{ transform: `translateY(${virtualItem.start}px)` }}
									>
										<button
											type="button"
											onClick={() => row.toggleExpanded()}
											className="flex w-full items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 text-left hover:bg-muted/50"
										>
											<ChevronRight
												size={14}
												className={cn('transition-transform', row.getIsExpanded() && 'rotate-90')}
											/>
											<span className="font-medium text-sm">{displayValue}</span>
											<span className="text-muted-foreground text-xs">({row.subRows.length})</span>
										</button>
									</li>
								)
							}

							return (
								<li
									key={row.id}
									data-index={virtualItem.index}
									ref={virtualizer.measureElement}
									className="absolute left-0 right-0"
									style={{ transform: `translateY(${virtualItem.start}px)` }}
								>
									<ObjectCard
										object={row.original}
										workspaceId={workspaceId}
										actors={actors}
										isSelected={row.getIsSelected()}
										onSelect={(selected) => row.toggleSelected(selected)}
										onClick={() => handleRowClick(row.original.id)}
									/>
								</li>
							)
						})}
					</ul>
				)}
				<div ref={sentinelRef} className="h-1" />
				{isFetchingNextPage && (
					<div className="flex items-center justify-center py-4">
						<Spinner />
					</div>
				)}
			</div>
		)
	}

	return (
		<div ref={parentRef} className="flex-1 min-h-0 overflow-auto rounded-md border">
			<Table>
				<TableHeader className="sticky top-0 z-10 bg-background">
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow key={headerGroup.id}>
							{headerGroup.headers.map((header) => (
								<TableHead
									key={header.id}
									style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
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
					{virtualItems.length === 0 ? (
						<TableRow>
							<TableCell colSpan={columns.length} className="h-24 text-center">
								No results.
							</TableCell>
						</TableRow>
					) : (
						<>
							{paddingTop > 0 && (
								<TableRow aria-hidden className="border-0">
									<TableCell colSpan={columns.length} style={{ height: paddingTop, padding: 0 }} />
								</TableRow>
							)}
							{virtualItems.map((virtualItem) => {
								const row = rows[virtualItem.index]
								if (!row) return null

								const isGrouped = row.getIsGrouped()

								if (isGrouped) {
									const groupingColumn = grouping?.[0]
									const rawValue = String(row.groupingValue)
									const displayValue =
										groupingColumn === 'owner' || groupingColumn === 'createdBy'
											? (actors?.find((a) => a.id === rawValue)?.name ?? rawValue)
											: rawValue
									return (
										<TableRow
											key={row.id}
											data-index={virtualItem.index}
											ref={virtualizer.measureElement}
											className="bg-muted/30 hover:bg-muted/50 cursor-pointer"
											onClick={() => row.toggleExpanded()}
										>
											<TableCell colSpan={columns.length}>
												<div className="flex items-center gap-2">
													<ChevronRight
														size={14}
														className={cn(
															'transition-transform',
															row.getIsExpanded() && 'rotate-90',
														)}
													/>
													<span className="font-medium text-sm">{displayValue}</span>
													<span className="text-muted-foreground text-xs">
														({row.subRows.length})
													</span>
												</div>
											</TableCell>
										</TableRow>
									)
								}

								return (
									<TableRow
										key={row.id}
										data-index={virtualItem.index}
										ref={virtualizer.measureElement}
										data-state={row.getIsSelected() && 'selected'}
										className="cursor-pointer"
										onClick={() => handleRowClick(row.original.id)}
									>
										{row.getVisibleCells().map((cell) => (
											<TableCell key={cell.id}>
												{cell.getIsAggregated()
													? null
													: flexRender(cell.column.columnDef.cell, cell.getContext())}
											</TableCell>
										))}
									</TableRow>
								)
							})}
							{paddingBottom > 0 && (
								<TableRow aria-hidden className="border-0">
									<TableCell
										colSpan={columns.length}
										style={{ height: paddingBottom, padding: 0 }}
									/>
								</TableRow>
							)}
						</>
					)}
				</TableBody>
			</Table>
			{/* Infinite scroll sentinel */}
			<div ref={sentinelRef} className="h-1" />
			{isFetchingNextPage && (
				<div className="flex items-center justify-center py-4">
					<Spinner />
				</div>
			)}
		</div>
	)
}
