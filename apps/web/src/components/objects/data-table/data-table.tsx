import { EmptyState } from '@/components/shared/empty-state'
import { Checkbox } from '@/components/ui/checkbox'
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

// Hit zone for the group-header select-all checkbox — matches T1's iOS 44×44 target on
// the row-level checkboxes so the new control isn't the one missed tap in the chain.
const GROUP_SELECT_TAP_TARGET =
	"relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"

function getGroupSelectState<T>(row: Row<T>): boolean | 'indeterminate' {
	const leaves = row.getLeafRows()
	if (leaves.length === 0) return false
	let selected = 0
	for (const leaf of leaves) {
		if (leaf.getCanSelect() && leaf.getIsSelected()) selected++
	}
	if (selected === 0) return false
	if (selected === leaves.length) return true
	return 'indeterminate'
}

function toggleGroupSelection<T>(table: TanstackTable<T>, row: Row<T>, value: boolean): void {
	const ids = row
		.getLeafRows()
		.filter((leaf) => leaf.getCanSelect())
		.map((leaf) => leaf.id)
	if (ids.length === 0) return
	table.setRowSelection((prev) => {
		const next = { ...prev }
		for (const id of ids) {
			if (value) next[id] = true
			else delete next[id]
		}
		return next
	})
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
import { useIsMobile, useIsTouchViewport } from '@/hooks/use-mobile'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useNavigate } from '@tanstack/react-router'
import {
	type ColumnDef,
	type GroupingState,
	type OnChangeFn,
	type Row,
	type RowSelectionState,
	type Table as TanstackTable,
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
import { useDragSelect } from './use-drag-select'

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
	const isTouchViewport = useIsTouchViewport()
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
		// Exclude synthetic group-header rows from selection — otherwise the
		// page-level "select all" checkbox sweeps in group pseudo-ids (e.g.
		// "status:active") alongside real object ids, and those bogus ids get
		// sent straight into bulk-update/delete mutations.
		enableRowSelection: (row) => !row.getIsGrouped(),
		autoResetExpanded: false,
		getRowId: (row) => row.id,
	})

	const { rows } = table.getRowModel()

	// The scroll container only mounts once loading/empty placeholders give way
	// to the real list below — gate attachment on that so the hook's listener
	// effect actually re-runs once the container exists (scrollRef's identity
	// never changes, so it can't signal that transition on its own).
	const { mode: dragMode } = useDragSelect({
		scrollRef: parentRef,
		table,
		enabled: !isLoading && data.length > 0,
	})

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		// At ≤1024px the row checkbox is 44px (AC-T6); bump row height so the
		// touch target isn't crushed against the row borders or other columns.
		estimateSize: () => (isMobile ? 96 : isTouchViewport ? 60 : 48),
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
			<div
				ref={parentRef}
				className={cn(
					'flex-1 min-h-0 overflow-auto rounded-md border',
					dragMode === 'drag' ? 'touch-none' : 'touch-pan-y',
				)}
			>
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
										<div className="flex w-full items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 hover:bg-muted/50">
											<Checkbox
												checked={getGroupSelectState(row)}
												onCheckedChange={(value) => toggleGroupSelection(table, row, !!value)}
												onClick={(e) => e.stopPropagation()}
												aria-label={`Select all in ${displayValue}`}
												className={cn('shrink-0', GROUP_SELECT_TAP_TARGET)}
											/>
											<button
												type="button"
												onClick={() => row.toggleExpanded()}
												aria-expanded={row.getIsExpanded()}
												className="flex flex-1 items-center gap-2 text-left"
											>
												<ChevronRight
													size={14}
													className={cn('transition-transform', row.getIsExpanded() && 'rotate-90')}
												/>
												<span className="font-medium text-sm">{displayValue}</span>
												<span className="text-muted-foreground text-xs tabular-nums">
													({row.subRows.length})
												</span>
											</button>
										</div>
									</li>
								)
							}

							return (
								<li
									key={row.id}
									data-index={virtualItem.index}
									data-drag-row={row.id}
									ref={virtualizer.measureElement}
									className={cn(
										'absolute left-0 right-0',
										'data-[drag-active-end=true]:before:content-[""]',
										'data-[drag-active-end=true]:before:absolute',
										'data-[drag-active-end=true]:before:inset-y-0',
										'data-[drag-active-end=true]:before:left-0',
										'data-[drag-active-end=true]:before:w-[3px]',
										'data-[drag-active-end=true]:before:bg-primary',
									)}
									style={{ transform: `translateY(${virtualItem.start}px)` }}
								>
									<ObjectCard
										object={row.original}
										workspaceId={workspaceId}
										actors={actors}
										isSelected={row.getIsSelected()}
										onSelect={(selected) => row.toggleSelected(selected)}
										onClick={() => handleRowClick(row.original.id)}
										betStatus={
											row.original.type === 'bet' && meta?.showBetStatusIndicator !== false
												? meta?.betStatuses?.get(row.original.id)
												: undefined
										}
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
		<div
			ref={parentRef}
			className={cn(
				'flex-1 min-h-0 overflow-auto rounded-md border',
				dragMode === 'drag' ? 'touch-none' : 'touch-pan-y',
			)}
		>
			<Table>
				<TableHeader className="sticky top-0 z-10 bg-background">
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow key={headerGroup.id}>
							{headerGroup.headers.map((header) => (
								<TableHead
									key={header.id}
									className={cn(header.column.id === 'title' && 'w-full')}
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
											className="bg-muted/30 hover:bg-muted/50"
										>
											<TableCell colSpan={columns.length}>
												<div className="flex items-center gap-2">
													<Checkbox
														checked={getGroupSelectState(row)}
														onCheckedChange={(value) => toggleGroupSelection(table, row, !!value)}
														onClick={(e) => e.stopPropagation()}
														aria-label={`Select all in ${displayValue}`}
														className={cn('shrink-0', GROUP_SELECT_TAP_TARGET)}
													/>
													<button
														type="button"
														onClick={() => row.toggleExpanded()}
														aria-expanded={row.getIsExpanded()}
														className="flex flex-1 items-center gap-2 text-left"
													>
														<ChevronRight
															size={14}
															className={cn(
																'transition-transform',
																row.getIsExpanded() && 'rotate-90',
															)}
														/>
														<span className="font-medium text-sm">{displayValue}</span>
														<span className="text-muted-foreground text-xs tabular-nums">
															({row.subRows.length})
														</span>
													</button>
												</div>
											</TableCell>
										</TableRow>
									)
								}

								const isArchivedRow = row.original.status === 'archived'
								return (
									<TableRow
										key={row.id}
										data-index={virtualItem.index}
										data-drag-row={row.id}
										data-archived={isArchivedRow ? '' : undefined}
										ref={virtualizer.measureElement}
										data-state={row.getIsSelected() && 'selected'}
										className={cn(
											'cursor-pointer relative',
											'data-[drag-active-end=true]:before:content-[""]',
											'data-[drag-active-end=true]:before:absolute',
											'data-[drag-active-end=true]:before:inset-y-0',
											'data-[drag-active-end=true]:before:left-0',
											'data-[drag-active-end=true]:before:w-[3px]',
											'data-[drag-active-end=true]:before:bg-primary',
											isArchivedRow && 'is-archived opacity-[0.62] hover:opacity-90',
										)}
										onClick={() => handleRowClick(row.original.id)}
									>
										{row.getVisibleCells().map((cell) => (
											<TableCell
												key={cell.id}
												className={cn(cell.column.id === 'title' && 'max-w-0')}
											>
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
