import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import type { ObjectResponse } from '@/lib/api'
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

interface DataTableProps {
	data: ObjectResponse[]
	columns: ColumnDef<ObjectResponse>[]
	workspaceId: string
	rowSelection: RowSelectionState
	onRowSelectionChange: OnChangeFn<RowSelectionState>
	columnVisibility: VisibilityState
	onColumnVisibilityChange: OnChangeFn<VisibilityState>
	grouping?: GroupingState
	hasNextPage?: boolean
	isFetchingNextPage?: boolean
	fetchNextPage?: () => void
	isLoading?: boolean
}

export function DataTable({
	data,
	columns,
	workspaceId,
	rowSelection,
	onRowSelectionChange,
	columnVisibility,
	onColumnVisibilityChange,
	grouping,
	hasNextPage,
	isFetchingNextPage,
	fetchNextPage,
	isLoading,
}: DataTableProps) {
	const navigate = useNavigate()
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
		estimateSize: () => 48,
		overscan: 20,
	})

	// Infinite scroll sentinel
	useEffect(() => {
		if (!sentinelRef.current || !hasNextPage || isFetchingNextPage) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) fetchNextPage?.()
			},
			{ rootMargin: '200px' },
		)
		observer.observe(sentinelRef.current)
		return () => observer.disconnect()
	}, [hasNextPage, isFetchingNextPage, fetchNextPage])

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

	return (
		<div ref={parentRef} className="h-[calc(100vh-180px)] overflow-auto rounded-md border">
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
					{virtualizer.getVirtualItems().length === 0 ? (
						<TableRow>
							<TableCell colSpan={columns.length} className="h-24 text-center">
								No results.
							</TableCell>
						</TableRow>
					) : (
						<>
							{virtualizer.getVirtualItems().map((virtualItem) => {
								const row = rows[virtualItem.index]
								if (!row) return null

								const isGrouped = row.getIsGrouped()

								if (isGrouped) {
									return (
										<TableRow
											key={row.id}
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
													<span className="font-medium text-sm">{String(row.groupingValue)}</span>
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
