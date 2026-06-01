import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { Separator } from '@/components/ui/separator'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { VisibilityState } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, Check, ChevronDown, SlidersHorizontal } from 'lucide-react'

export interface DisplayPanelColumn {
	id: string
	label: string
	canHide: boolean
}

export interface DisplayPanelProps {
	// Column visibility (Properties section)
	columns?: DisplayPanelColumn[]
	columnVisibility?: VisibilityState
	onColumnVisibilityChange?: (columnId: string, visible: boolean) => void
	// Filters — comma-separated strings for multi-select
	statusFilter?: string
	onStatusFilterChange?: (value: string | undefined) => void
	statusesByType?: Record<string, string[]>
	ownerFilter?: string
	onOwnerFilterChange?: (value: string | undefined) => void
	actors?: ActorListItem[]
	onResetFilters?: () => void
	// Ordering
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

function SectionHeader({ children }: { children: React.ReactNode }) {
	return (
		<p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
			{children}
		</p>
	)
}

function PillButton({
	active,
	disabled,
	onClick,
	children,
	title,
}: {
	active?: boolean
	disabled?: boolean
	onClick?: () => void
	children: React.ReactNode
	title?: string
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			title={title}
			onClick={onClick}
			className={cn(
				'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
				active
					? 'border-accent bg-accent text-accent-foreground'
					: 'border-border bg-bg-surface text-text-secondary hover:text-foreground hover:border-border-hover',
				disabled && 'cursor-not-allowed opacity-50 hover:text-text-secondary hover:border-border',
			)}
		>
			{children}
		</button>
	)
}

function PickerRow({
	label,
	value,
	placeholder,
	children,
	trailing,
}: {
	label: string
	value?: string
	placeholder: string
	children: React.ReactNode
	trailing?: React.ReactNode
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-16 shrink-0 text-xs text-text-secondary">{label}</span>
			<div className="flex flex-1 items-center gap-1.5">
				{children}
				{trailing}
				<span className="sr-only">{value ?? placeholder}</span>
			</div>
		</div>
	)
}

const DROPDOWN_CLS = 'min-w-[10rem] max-h-64 overflow-y-auto'

export function DisplayPanel({
	columns = [],
	columnVisibility,
	onColumnVisibilityChange,
	statusFilter,
	onStatusFilterChange,
	statusesByType = {},
	ownerFilter,
	onOwnerFilterChange,
	actors,
	onResetFilters,
	sort,
	onSortChange,
	order,
	onOrderChange,
	groupBy,
	onGroupByChange,
	iconOnly = false,
}: DisplayPanelProps) {
	const activeStatuses = statusFilter ? statusFilter.split(',').filter(Boolean) : []
	const activeOwners = ownerFilter ? ownerFilter.split(',').filter(Boolean) : []
	const activeFilterCount = (activeStatuses.length > 0 ? 1 : 0) + (activeOwners.length > 0 ? 1 : 0)
	const hasActiveFilters = activeFilterCount > 0

	const showOrdering = !!sort && !!order && !!onSortChange && !!onOrderChange && columns.length > 0
	const showGrouping = !!onGroupByChange && columns.length > 0
	const showFilters = !!onStatusFilterChange || !!onOwnerFilterChange
	const hideableColumns = columns.filter((col) => col.canHide)
	const showProperties = !!onColumnVisibilityChange && hideableColumns.length > 0

	const sortLabel = columns.find((c) => c.id === sort)?.label
	const groupLabel = columns.find((c) => c.id === groupBy)?.label

	const typeEntries = Object.entries(statusesByType).filter(([, statuses]) => statuses.length > 0)
	const hasStatuses = typeEntries.length > 0

	const ownerOptions = actors ?? []
	const hasOwners = ownerOptions.length > 0

	function toggleStatus(status: string) {
		const next = activeStatuses.includes(status)
			? activeStatuses.filter((s) => s !== status)
			: [...activeStatuses, status]
		onStatusFilterChange?.(next.length > 0 ? next.join(',') : undefined)
	}

	function toggleOwner(ownerId: string) {
		const next = activeOwners.includes(ownerId)
			? activeOwners.filter((id) => id !== ownerId)
			: [...activeOwners, ownerId]
		onOwnerFilterChange?.(next.length > 0 ? next.join(',') : undefined)
	}

	const statusTriggerLabel =
		activeStatuses.length === 0
			? '+ Status'
			: activeStatuses.length === 1
				? activeStatuses[0]?.replace(/_/g, ' ')
				: `${activeStatuses.length} statuses`

	const ownerTriggerLabel =
		activeOwners.length === 0
			? '+ Owner'
			: activeOwners.length === 1
				? (ownerOptions.find((a) => a.id === activeOwners[0])?.name ?? '1 owner')
				: `${activeOwners.length} owners`

	return (
		<ResponsivePopover>
			<ResponsivePopoverTrigger asChild>
				{iconOnly ? (
					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8 relative"
						title="Display"
						aria-label="Display"
					>
						<SlidersHorizontal size={14} />
						{hasActiveFilters && (
							<span className="absolute -top-0.5 -right-0.5 rounded-full bg-primary text-primary-foreground text-[10px] leading-none px-1 py-0.5 min-w-[14px] text-center">
								{activeFilterCount}
							</span>
						)}
					</Button>
				) : (
					<Button variant="outline" size="sm" className="gap-1.5">
						<SlidersHorizontal size={14} />
						Display
						{hasActiveFilters && (
							<span className="ml-1 rounded-full bg-primary text-primary-foreground text-xs px-1.5 py-0.5">
								{activeFilterCount}
							</span>
						)}
					</Button>
				)}
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent align="end" accessibleTitle="Display" className="md:w-80 md:p-0">
				<div className="md:max-h-[480px] md:overflow-y-auto text-left">
					{/* View */}
					<div className="p-3 space-y-2">
						<SectionHeader>View</SectionHeader>
						<div className="flex items-center gap-1.5">
							<PillButton active>List</PillButton>
							<PillButton
								disabled
								title="Board view — coming soon"
								aria-label="Board view (coming soon)"
							>
								Board
							</PillButton>
						</div>
					</div>
					<Separator />

					{/* Ordering */}
					{showOrdering && (
						<>
							<div className="p-3 space-y-2">
								<SectionHeader>Ordering</SectionHeader>
								<PickerRow label="Sort by" value={sortLabel} placeholder="Sort">
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="outline"
												size="sm"
												className="h-7 flex-1 justify-between gap-1.5 px-2 text-xs"
											>
												<span className="truncate capitalize">{sortLabel ?? 'Created'}</span>
												<ChevronDown size={12} className="shrink-0 opacity-60" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="start" className={DROPDOWN_CLS}>
											{columns.map((col) => (
												<DropdownMenuItem
													key={col.id}
													onClick={() => onSortChange?.(col.id)}
													className="capitalize"
												>
													<span className="flex-1">{col.label}</span>
													{sort === col.id && <Check size={12} className="opacity-60" />}
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
									<button
										type="button"
										aria-label={order === 'asc' ? 'Ascending' : 'Descending'}
										title={order === 'asc' ? 'Ascending' : 'Descending'}
										onClick={() => onOrderChange?.(order === 'asc' ? 'desc' : 'asc')}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-secondary hover:text-foreground hover:border-border-hover transition-colors"
									>
										{order === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
									</button>
								</PickerRow>
							</div>
							<Separator />
						</>
					)}

					{/* Grouping */}
					{showGrouping && (
						<>
							<div className="p-3 space-y-2">
								<SectionHeader>Grouping</SectionHeader>
								<PickerRow label="Group by" value={groupLabel ?? 'None'} placeholder="None">
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="outline"
												size="sm"
												className="h-7 flex-1 justify-between gap-1.5 px-2 text-xs"
											>
												<span className="truncate capitalize">{groupLabel ?? 'None'}</span>
												<ChevronDown size={12} className="shrink-0 opacity-60" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="start" className={DROPDOWN_CLS}>
											<DropdownMenuItem onClick={() => onGroupByChange?.(undefined)}>
												<span className="flex-1">None</span>
												{!groupBy && <Check size={12} className="opacity-60" />}
											</DropdownMenuItem>
											{columns.map((col) => (
												<DropdownMenuItem
													key={col.id}
													onClick={() => onGroupByChange?.(col.id)}
													className="capitalize"
												>
													<span className="flex-1">{col.label}</span>
													{groupBy === col.id && <Check size={12} className="opacity-60" />}
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								</PickerRow>
							</div>
							<Separator />
						</>
					)}

					{/* Filters */}
					{showFilters && (
						<>
							<div className="p-3 space-y-2">
								<div className="flex items-center justify-between">
									<SectionHeader>Filters</SectionHeader>
									{hasActiveFilters && (
										<button
											type="button"
											className="text-[11px] text-text-secondary hover:text-foreground transition-colors"
											onClick={() => {
												if (onResetFilters) {
													onResetFilters()
												} else {
													onStatusFilterChange?.(undefined)
													onOwnerFilterChange?.(undefined)
												}
											}}
										>
											Reset
										</button>
									)}
								</div>

								{/* Status — grouped by type with separators, multi-select */}
								{onStatusFilterChange && (
									<div className="flex items-center gap-2">
										<span className="w-16 shrink-0 text-xs text-text-secondary">Status</span>
										<DropdownMenu>
											<DropdownMenuTrigger asChild disabled={!hasStatuses}>
												<Button
													variant={activeStatuses.length > 0 ? 'outline' : 'ghost'}
													size="sm"
													className={cn(
														'h-7 gap-1.5 px-2 text-xs',
														activeStatuses.length === 0 &&
															'text-text-secondary hover:text-foreground',
													)}
												>
													<span className="truncate capitalize">{statusTriggerLabel}</span>
													{hasStatuses && <ChevronDown size={12} className="shrink-0 opacity-60" />}
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="start" className={DROPDOWN_CLS}>
												{typeEntries.map(([type, statuses], i) => (
													<div key={type}>
														{i > 0 && <DropdownMenuSeparator />}
														<DropdownMenuLabel className="capitalize text-xs font-medium text-text-secondary py-1">
															{type}
														</DropdownMenuLabel>
														{statuses.map((status) => (
															<DropdownMenuCheckboxItem
																key={status}
																checked={activeStatuses.includes(status)}
																onCheckedChange={() => toggleStatus(status)}
																className="capitalize"
															>
																{status.replace(/_/g, ' ')}
															</DropdownMenuCheckboxItem>
														))}
													</div>
												))}
											</DropdownMenuContent>
										</DropdownMenu>
										{activeStatuses.length > 0 && (
											<button
												type="button"
												aria-label="Clear Status filter"
												title="Clear Status filter"
												onClick={() => onStatusFilterChange?.(undefined)}
												className="text-[11px] text-text-secondary hover:text-foreground transition-colors"
											>
												Clear
											</button>
										)}
									</div>
								)}

								{/* Owner — flat multi-select */}
								{onOwnerFilterChange && (
									<div className="flex items-center gap-2">
										<span className="w-16 shrink-0 text-xs text-text-secondary">Owner</span>
										<DropdownMenu>
											<DropdownMenuTrigger asChild disabled={!hasOwners}>
												<Button
													variant={activeOwners.length > 0 ? 'outline' : 'ghost'}
													size="sm"
													className={cn(
														'h-7 gap-1.5 px-2 text-xs',
														activeOwners.length === 0 &&
															'text-text-secondary hover:text-foreground',
													)}
												>
													<span className="truncate">{ownerTriggerLabel}</span>
													{hasOwners && <ChevronDown size={12} className="shrink-0 opacity-60" />}
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="start" className={DROPDOWN_CLS}>
												{ownerOptions.map((actor) => (
													<DropdownMenuCheckboxItem
														key={actor.id}
														checked={activeOwners.includes(actor.id)}
														onCheckedChange={() => toggleOwner(actor.id)}
													>
														{actor.name}
													</DropdownMenuCheckboxItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>
										{activeOwners.length > 0 && (
											<button
												type="button"
												aria-label="Clear Owner filter"
												title="Clear Owner filter"
												onClick={() => onOwnerFilterChange?.(undefined)}
												className="text-[11px] text-text-secondary hover:text-foreground transition-colors"
											>
												Clear
											</button>
										)}
									</div>
								)}
							</div>
							<Separator />
						</>
					)}

					{/* Properties */}
					{showProperties && (
						<div className="p-3 space-y-2">
							<SectionHeader>Properties</SectionHeader>
							<div className="flex flex-wrap gap-1.5">
								{hideableColumns.map((col) => {
									const isVisible = columnVisibility?.[col.id] !== false
									return (
										<PillButton
											key={col.id}
											active={isVisible}
											onClick={() => onColumnVisibilityChange?.(col.id, !isVisible)}
										>
											<span className="capitalize">{col.label}</span>
										</PillButton>
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
