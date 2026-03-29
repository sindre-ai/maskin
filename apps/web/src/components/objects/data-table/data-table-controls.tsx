import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
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
	columns: ColumnInfo[]
	columnVisibility: VisibilityState
	onColumnVisibilityChange: (columnId: string, visible: boolean) => void
	// Filters
	statusFilter?: string
	onStatusFilterChange: (value: string | undefined) => void
	allStatuses: string[]
	ownerFilter?: string
	onOwnerFilterChange: (value: string | undefined) => void
	actors?: Array<{ id: string; name: string }>
	// Sort
	sort: string
	onSortChange: (value: string) => void
	order: 'asc' | 'desc'
	onOrderChange: (value: 'asc' | 'desc') => void
	// Grouping
	groupBy?: string
	onGroupByChange: (value: string | undefined) => void
	showGroupByType?: boolean
}

const sortOptions = [
	{ value: 'createdAt', label: 'Created' },
	{ value: 'updatedAt', label: 'Updated' },
	{ value: 'title', label: 'Title' },
	{ value: 'status', label: 'Status' },
]

export function DataTableControls({
	columns,
	columnVisibility,
	onColumnVisibilityChange,
	statusFilter,
	onStatusFilterChange,
	allStatuses,
	ownerFilter,
	onOwnerFilterChange,
	actors,
	sort,
	onSortChange,
	order,
	onOrderChange,
	groupBy,
	onGroupByChange,
	showGroupByType = true,
}: DataTableControlsProps) {
	const hasActiveFilters = !!statusFilter || !!ownerFilter

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5">
					<Settings2 size={14} />
					Controls
					{hasActiveFilters && (
						<span className="ml-1 rounded-full bg-primary text-primary-foreground text-xs px-1.5 py-0.5">
							{(statusFilter ? 1 : 0) + (ownerFilter ? 1 : 0)}
						</span>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64 p-0">
				<div className="max-h-[420px] overflow-y-auto">
					{/* Filter by Status */}
					{allStatuses.length > 0 && (
						<>
							<div className="p-3">
								<p className="text-xs font-medium text-muted-foreground mb-2">Filter by status</p>
								<div className="space-y-1">
									{allStatuses.map((s) => (
										<div
											key={s}
											className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50 cursor-pointer text-sm"
										>
											<Checkbox
												checked={statusFilter === s}
												onCheckedChange={(checked) => onStatusFilterChange(checked ? s : undefined)}
											/>
											{s.replace(/_/g, ' ')}
										</div>
									))}
								</div>
							</div>
							<Separator />
						</>
					)}

					{/* Filter by Owner */}
					{actors && actors.length > 0 && (
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
					<div className="p-3">
						<div className="flex items-center justify-between mb-2">
							<p className="text-xs font-medium text-muted-foreground">Sort by</p>
							<button
								type="button"
								className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
								onClick={() => onOrderChange(order === 'asc' ? 'desc' : 'asc')}
							>
								{order === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
								{order === 'asc' ? 'Ascending' : 'Descending'}
							</button>
						</div>
						<div className="space-y-1">
							{sortOptions.map((option) => (
								<button
									key={option.value}
									type="button"
									className={cn(
										'w-full text-left py-1 px-2 rounded text-sm transition-colors',
										sort === option.value
											? 'bg-muted text-foreground font-medium'
											: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
									)}
									onClick={() => onSortChange(option.value)}
								>
									{option.label}
								</button>
							))}
						</div>
					</div>

					<Separator />

					{/* Group by */}
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
								onClick={() => onGroupByChange(undefined)}
							>
								None
							</button>
							{showGroupByType && (
								<button
									type="button"
									className={cn(
										'w-full text-left py-1 px-2 rounded text-sm transition-colors',
										groupBy === 'type'
											? 'bg-muted text-foreground font-medium'
											: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
									)}
									onClick={() => onGroupByChange('type')}
								>
									Type
								</button>
							)}
							<button
								type="button"
								className={cn(
									'w-full text-left py-1 px-2 rounded text-sm transition-colors',
									groupBy === 'status'
										? 'bg-muted text-foreground font-medium'
										: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
								)}
								onClick={() => onGroupByChange('status')}
							>
								Status
							</button>
						</div>
					</div>

					<Separator />

					{/* Column visibility */}
					<div className="p-3">
						<p className="text-xs font-medium text-muted-foreground mb-2">Columns</p>
						<div className="space-y-1">
							{columns
								.filter((col) => col.canHide)
								.map((col) => {
									const isVisible = columnVisibility[col.id] !== false
									return (
										<div
											key={col.id}
											className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50 cursor-pointer text-sm"
										>
											<Checkbox
												checked={isVisible}
												onCheckedChange={(value) => onColumnVisibilityChange(col.id, !!value)}
											/>
											{col.label}
										</div>
									)
								})}
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
