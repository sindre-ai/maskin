import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { Separator } from '@/components/ui/separator'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { VisibilityState } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, Settings2 } from 'lucide-react'

export interface ColumnInfo {
	id: string
	label: string
	canHide: boolean
}

interface DataTableControlsProps {
	// Column visibility
	columns?: ColumnInfo[]
	columnVisibility?: VisibilityState
	onColumnVisibilityChange?: (columnId: string, visible: boolean) => void
	// Filters
	statusFilter?: string
	onStatusFilterChange?: (value: string | undefined) => void
	statusesByType?: Record<string, string[]>
	ownerFilter?: string
	onOwnerFilterChange?: (value: string | undefined) => void
	actors?: ActorListItem[]
	typeFilter?: string
	onTypeFilterChange?: (value: string | undefined) => void
	typeCounts?: Record<string, number>
	// Sort
	sort?: string
	onSortChange?: (value: string) => void
	order?: 'asc' | 'desc'
	onOrderChange?: (value: 'asc' | 'desc') => void
	// Grouping
	groupBy?: string
	onGroupByChange?: (value: string | undefined) => void
	// Trigger appearance
	iconOnly?: boolean
}

export function DataTableControls({
	columns = [],
	columnVisibility,
	onColumnVisibilityChange,
	statusFilter,
	onStatusFilterChange,
	statusesByType = {},
	ownerFilter,
	onOwnerFilterChange,
	actors,
	typeFilter,
	onTypeFilterChange,
	typeCounts,
	sort,
	onSortChange,
	order,
	onOrderChange,
	groupBy,
	onGroupByChange,
	iconOnly = false,
}: DataTableControlsProps) {
	const hasActiveFilters = !!statusFilter || !!ownerFilter || !!typeFilter
	const activeFilterCount = (statusFilter ? 1 : 0) + (ownerFilter ? 1 : 0) + (typeFilter ? 1 : 0)
	const showTypeFilter = !!onTypeFilterChange && !!typeCounts && Object.keys(typeCounts).length > 0
	const showSort = !!sort && !!order && !!onSortChange && !!onOrderChange && columns.length > 0
	const showGroupBy = !!onGroupByChange && columns.length > 0
	const hideableColumns = columns.filter((col) => col.canHide)
	const showColumns = !!onColumnVisibilityChange && hideableColumns.length > 0

	return (
		<ResponsivePopover>
			<ResponsivePopoverTrigger asChild>
				{iconOnly ? (
					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8 relative"
						title="Controls"
						aria-label="Controls"
					>
						<Settings2 size={14} />
						{hasActiveFilters && (
							<span className="absolute -top-0.5 -right-0.5 rounded-full bg-primary text-primary-foreground text-[10px] leading-none px-1 py-0.5 min-w-[14px] text-center">
								{activeFilterCount}
							</span>
						)}
					</Button>
				) : (
					<Button variant="outline" size="sm" className="gap-1.5">
						<Settings2 size={14} />
						Controls
						{hasActiveFilters && (
							<span className="ml-1 rounded-full bg-primary text-primary-foreground text-xs px-1.5 py-0.5">
								{activeFilterCount}
							</span>
						)}
					</Button>
				)}
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent align="end" accessibleTitle="Controls" className="md:w-64 md:p-0">
				<div className="max-h-[420px] overflow-y-auto text-left">
					{/* Filter by Type */}
					{showTypeFilter && (
						<>
							<div className="p-3">
								<p className="text-xs font-medium text-muted-foreground mb-2">Filter by type</p>
								<div className="space-y-1">
									{Object.entries(typeCounts).map(([type, count]) => (
										<div
											key={type}
											className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50 cursor-pointer text-sm capitalize"
										>
											<Checkbox
												checked={typeFilter === type}
												onCheckedChange={(checked) =>
													onTypeFilterChange?.(checked ? type : undefined)
												}
											/>
											<span className="flex-1">{type}</span>
											<span className="text-xs text-muted-foreground">{count}</span>
										</div>
									))}
								</div>
							</div>
							<Separator />
						</>
					)}

					{/* Filter by Status */}
					{Object.keys(statusesByType).length > 0 && onStatusFilterChange && (
						<>
							<div className="p-3">
								<p className="text-xs font-medium text-muted-foreground mb-2">Filter by status</p>
								<div className="space-y-1">
									{Object.entries(statusesByType).map(([type, statuses]) => {
										const showTypeHeader = Object.keys(statusesByType).length > 1
										return (
											<div key={type}>
												{showTypeHeader && (
													<p className="text-xs font-medium text-muted-foreground mt-2 mb-1 capitalize">
														{type}
													</p>
												)}
												{statuses.map((s) => (
													<div
														key={s}
														className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50 cursor-pointer text-sm"
													>
														<Checkbox
															checked={statusFilter === s}
															onCheckedChange={(checked) =>
																onStatusFilterChange?.(checked ? s : undefined)
															}
														/>
														{s.replace(/_/g, ' ')}
													</div>
												))}
											</div>
										)
									})}
								</div>
							</div>
							<Separator />
						</>
					)}

					{/* Filter by Owner */}
					{actors && actors.length > 0 && onOwnerFilterChange && (
						<>
							<div className="p-3">
								<p className="text-xs font-medium text-muted-foreground mb-2">Filter by owner</p>
								<div className="space-y-1">
									{actors.map((a) => (
										<div
											key={a.id}
											className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50 cursor-pointer text-sm"
										>
											<Checkbox
												checked={ownerFilter === a.id}
												onCheckedChange={(checked) =>
													onOwnerFilterChange(checked ? a.id : undefined)
												}
											/>
											{a.name}
										</div>
									))}
								</div>
							</div>
							<Separator />
						</>
					)}

					{/* Sort */}
					{showSort && (
						<>
							<div className="p-3">
								<div className="flex items-center justify-between mb-2">
									<p className="text-xs font-medium text-muted-foreground">Sort by</p>
									<button
										type="button"
										className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
										onClick={() => onOrderChange?.(order === 'asc' ? 'desc' : 'asc')}
									>
										{order === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
										{order === 'asc' ? 'Ascending' : 'Descending'}
									</button>
								</div>
								<div className="space-y-1">
									{columns.map((col) => (
										<button
											key={col.id}
											type="button"
											className={cn(
												'w-full text-left py-1 px-2 rounded text-sm transition-colors capitalize',
												sort === col.id
													? 'bg-muted text-foreground font-medium'
													: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
											)}
											onClick={() => onSortChange?.(col.id)}
										>
											{col.label}
										</button>
									))}
								</div>
							</div>
							<Separator />
						</>
					)}

					{/* Group by */}
					{showGroupBy && (
						<>
							<div className="p-3">
								<p className="text-xs font-medium text-muted-foreground mb-2">Group by</p>
								<div className="space-y-1">
									<button
										type="button"
										className={cn(
											'w-full text-left py-1 px-2 rounded text-sm transition-colors',
											!groupBy
												? 'bg-muted text-foreground font-medium'
												: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
										)}
										onClick={() => onGroupByChange?.(undefined)}
									>
										None
									</button>
									{columns.map((col) => (
										<button
											key={col.id}
											type="button"
											className={cn(
												'w-full text-left py-1 px-2 rounded text-sm transition-colors capitalize',
												groupBy === col.id
													? 'bg-muted text-foreground font-medium'
													: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
											)}
											onClick={() => onGroupByChange?.(col.id)}
										>
											{col.label}
										</button>
									))}
								</div>
							</div>
							<Separator />
						</>
					)}

					{/* Column visibility */}
					{showColumns && (
						<div className="p-3">
							<p className="text-xs font-medium text-muted-foreground mb-2">Columns</p>
							<div className="space-y-1">
								{hideableColumns.map((col) => {
									const isVisible = columnVisibility?.[col.id] !== false
									return (
										<div
											key={col.id}
											className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50 cursor-pointer text-sm"
										>
											<Checkbox
												checked={isVisible}
												onCheckedChange={(value) => onColumnVisibilityChange?.(col.id, !!value)}
											/>
											{col.label}
										</div>
									)
								})}
							</div>
						</div>
					)}
				</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}
