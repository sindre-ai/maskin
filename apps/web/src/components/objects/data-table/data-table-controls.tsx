import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { Separator } from '@/components/ui/separator'
import { trackEvent } from '@/lib/analytics'
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
	driverFilter?: string
	onDriverFilterChange?: (value: string | undefined) => void
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
	// Analytics — when set, control changes emit a tracked event tagged with this source
	analyticsSource?: string
}

export function DataTableControls({
	columns = [],
	columnVisibility,
	onColumnVisibilityChange,
	statusFilter,
	onStatusFilterChange,
	statusesByType = {},
	driverFilter,
	onDriverFilterChange,
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
	analyticsSource,
}: DataTableControlsProps) {
	const track = (control: string, value: string | undefined) => {
		if (!analyticsSource) return
		trackEvent('objects_control_changed', {
			source: analyticsSource,
			control,
			value: value ?? null,
		})
	}

	const hasActiveFilters = !!statusFilter || !!driverFilter || !!typeFilter
	const activeFilterCount = (statusFilter ? 1 : 0) + (driverFilter ? 1 : 0) + (typeFilter ? 1 : 0)
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
							<span className="absolute -top-0.5 -right-0.5 rounded-full bg-primary text-primary-foreground text-badge px-[var(--space-1)] py-[2px] min-w-[14px] text-center">
								{activeFilterCount}
							</span>
						)}
					</Button>
				) : (
					<Button variant="outline" size="sm" className="gap-[6px]">
						<Settings2 size={14} />
						Controls
						{hasActiveFilters && (
							<span className="ml-[var(--space-1)] rounded-full bg-primary text-primary-foreground text-caption px-[6px] py-[2px]">
								{activeFilterCount}
							</span>
						)}
					</Button>
				)}
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent align="end" accessibleTitle="Controls" className="md:w-64 md:p-[0]">
				<div className="max-h-[420px] overflow-y-auto text-left">
					{/* Filter by Type */}
					{showTypeFilter && (
						<>
							<div className="p-[var(--space-3)]">
								<p className="text-caption font-medium text-muted-foreground mb-[var(--space-2)]">
									Filter by type
								</p>
								<div className="space-y-[var(--space-1)]">
									{Object.entries(typeCounts).map(([type, count]) => (
										<div
											key={type}
											className="flex items-center gap-[var(--space-2)] py-[var(--space-1)] px-[var(--space-1)] rounded hover:bg-muted/50 cursor-pointer text-label capitalize"
										>
											<Checkbox
												checked={typeFilter === type}
												onCheckedChange={(checked) => {
													const next = checked ? type : undefined
													track('type_filter', next)
													onTypeFilterChange?.(next)
												}}
											/>
											<span className="flex-1">{type}</span>
											<span className="text-caption text-muted-foreground">{count}</span>
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
							<div className="p-[var(--space-3)]">
								<p className="text-caption font-medium text-muted-foreground mb-[var(--space-2)]">
									Filter by status
								</p>
								<div className="space-y-[var(--space-1)]">
									{Object.entries(statusesByType).map(([type, statuses]) => {
										const showTypeHeader = Object.keys(statusesByType).length > 1
										return (
											<div key={type}>
												{showTypeHeader && (
													<p className="text-caption font-medium text-muted-foreground mt-[var(--space-2)] mb-[var(--space-1)] capitalize">
														{type}
													</p>
												)}
												{statuses.map((s) => (
													<div
														key={s}
														className="flex items-center gap-[var(--space-2)] py-[var(--space-1)] px-[var(--space-1)] rounded hover:bg-muted/50 cursor-pointer text-label"
													>
														<Checkbox
															checked={statusFilter === s}
															onCheckedChange={(checked) => {
																const next = checked ? s : undefined
																track('status_filter', next)
																onStatusFilterChange?.(next)
															}}
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

					{/* Filter by Driver */}
					{actors && actors.length > 0 && onDriverFilterChange && (
						<>
							<div className="p-[var(--space-3)]">
								<p className="text-caption font-medium text-muted-foreground mb-[var(--space-2)]">
									Filter by driver
								</p>
								<div className="space-y-[var(--space-1)]">
									{actors.map((a) => (
										<div
											key={a.id}
											className="flex items-center gap-[var(--space-2)] py-[var(--space-1)] px-[var(--space-1)] rounded hover:bg-muted/50 cursor-pointer text-label"
										>
											<Checkbox
												checked={driverFilter === a.id}
												onCheckedChange={(checked) => {
													const next = checked ? a.id : undefined
													track('driver_filter', next)
													onDriverFilterChange(next)
												}}
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
							<div className="p-[var(--space-3)]">
								<div className="flex items-center justify-between mb-[var(--space-2)]">
									<p className="text-caption font-medium text-muted-foreground">Sort by</p>
									<button
										type="button"
										className="flex items-center gap-[var(--space-1)] text-caption text-muted-foreground hover:text-foreground transition-colors duration-micro ease-default"
										onClick={() => {
											const next = order === 'asc' ? 'desc' : 'asc'
											track('sort_order', next)
											onOrderChange?.(next)
										}}
									>
										{order === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
										{order === 'asc' ? 'Ascending' : 'Descending'}
									</button>
								</div>
								<div className="space-y-[var(--space-1)]">
									{columns.map((col) => (
										<button
											key={col.id}
											type="button"
											className={cn(
												'w-full text-left py-[var(--space-1)] px-[var(--space-2)] rounded text-label transition-colors duration-micro ease-default capitalize',
												sort === col.id
													? 'bg-muted text-foreground font-medium'
													: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
											)}
											onClick={() => {
												track('sort_by', col.id)
												onSortChange?.(col.id)
											}}
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
							<div className="p-[var(--space-3)]">
								<p className="text-caption font-medium text-muted-foreground mb-[var(--space-2)]">
									Group by
								</p>
								<div className="space-y-[var(--space-1)]">
									<button
										type="button"
										className={cn(
											'w-full text-left py-[var(--space-1)] px-[var(--space-2)] rounded text-label transition-colors duration-micro ease-default',
											!groupBy
												? 'bg-muted text-foreground font-medium'
												: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
										)}
										onClick={() => {
											track('group_by', undefined)
											onGroupByChange?.(undefined)
										}}
									>
										None
									</button>
									{columns.map((col) => (
										<button
											key={col.id}
											type="button"
											className={cn(
												'w-full text-left py-[var(--space-1)] px-[var(--space-2)] rounded text-label transition-colors duration-micro ease-default capitalize',
												groupBy === col.id
													? 'bg-muted text-foreground font-medium'
													: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
											)}
											onClick={() => {
												track('group_by', col.id)
												onGroupByChange?.(col.id)
											}}
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
						<div className="p-[var(--space-3)]">
							<p className="text-caption font-medium text-muted-foreground mb-[var(--space-2)]">
								Columns
							</p>
							<div className="space-y-[var(--space-1)]">
								{hideableColumns.map((col) => {
									const isVisible = columnVisibility?.[col.id] !== false
									return (
										<div
											key={col.id}
											className="flex items-center gap-[var(--space-2)] py-[var(--space-1)] px-[var(--space-1)] rounded hover:bg-muted/50 cursor-pointer text-label"
										>
											<Checkbox
												checked={isVisible}
												onCheckedChange={(value) => {
													const visible = !!value
													track('column_visibility', `${col.id}:${visible ? 'show' : 'hide'}`)
													onColumnVisibilityChange?.(col.id, visible)
												}}
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
