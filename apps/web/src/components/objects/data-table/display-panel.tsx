import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
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
	// Filters
	statusFilter?: string
	onStatusFilterChange?: (value: string | undefined) => void
	statuses?: string[]
	ownerFilter?: string
	onOwnerFilterChange?: (value: string | undefined) => void
	actors?: ActorListItem[]
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

export function DisplayPanel({
	columns = [],
	columnVisibility,
	onColumnVisibilityChange,
	statusFilter,
	onStatusFilterChange,
	statuses = [],
	ownerFilter,
	onOwnerFilterChange,
	actors,
	sort,
	onSortChange,
	order,
	onOrderChange,
	groupBy,
	onGroupByChange,
	iconOnly = false,
}: DisplayPanelProps) {
	const activeFilterCount = (statusFilter ? 1 : 0) + (ownerFilter ? 1 : 0)
	const hasActiveFilters = activeFilterCount > 0

	const showOrdering = !!sort && !!order && !!onSortChange && !!onOrderChange && columns.length > 0
	const showGrouping = !!onGroupByChange && columns.length > 0
	const showFilters = !!onStatusFilterChange || !!onOwnerFilterChange
	const hideableColumns = columns.filter((col) => col.canHide)
	const showProperties = !!onColumnVisibilityChange && hideableColumns.length > 0

	const sortLabel = columns.find((c) => c.id === sort)?.label
	const groupLabel = columns.find((c) => c.id === groupBy)?.label

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
				<div className="max-h-[480px] overflow-y-auto text-left">
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
										<DropdownMenuContent align="start" className="min-w-[10rem]">
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
										<DropdownMenuContent align="start" className="min-w-[10rem]">
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
												onStatusFilterChange?.(undefined)
												onOwnerFilterChange?.(undefined)
											}}
										>
											Reset
										</button>
									)}
								</div>

								{/* Status */}
								{onStatusFilterChange && (
									<FilterRow
										label="Status"
										current={statusFilter}
										options={statuses.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
										onChange={onStatusFilterChange}
										emptyHint="No statuses available"
									/>
								)}

								{/* Owner */}
								{onOwnerFilterChange && (
									<FilterRow
										label="Owner"
										current={ownerFilter}
										options={(actors ?? []).map((a) => ({ value: a.id, label: a.name }))}
										onChange={onOwnerFilterChange}
										emptyHint="No owners"
									/>
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

interface FilterRowProps {
	label: string
	current: string | undefined
	options: Array<{ value: string; label: string }>
	onChange: (value: string | undefined) => void
	emptyHint: string
}

function FilterRow({ label, current, options, onChange, emptyHint }: FilterRowProps) {
	const currentLabel = options.find((o) => o.value === current)?.label
	const triggerText = currentLabel ?? `+ ${label}`
	return (
		<div className="flex items-center gap-2">
			<span className="w-16 shrink-0 text-xs text-text-secondary">{label}</span>
			<DropdownMenu>
				<DropdownMenuTrigger asChild disabled={options.length === 0}>
					<Button
						variant={current ? 'outline' : 'ghost'}
						size="sm"
						className={cn(
							'h-7 gap-1.5 px-2 text-xs',
							!current && 'text-text-secondary hover:text-foreground',
						)}
					>
						<span className="truncate capitalize">
							{options.length === 0 ? emptyHint : triggerText}
						</span>
						{options.length > 0 && <ChevronDown size={12} className="shrink-0 opacity-60" />}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-[10rem]">
					{options.map((opt) => (
						<DropdownMenuItem
							key={opt.value}
							onClick={() => onChange(current === opt.value ? undefined : opt.value)}
							className="capitalize"
						>
							<span className="flex-1">{opt.label}</span>
							{current === opt.value && <Check size={12} className="opacity-60" />}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			{current && (
				<button
					type="button"
					aria-label={`Clear ${label} filter`}
					title={`Clear ${label} filter`}
					onClick={() => onChange(undefined)}
					className="text-[11px] text-text-secondary hover:text-foreground transition-colors"
				>
					Clear
				</button>
			)}
		</div>
	)
}
