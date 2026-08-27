import { type FieldDefinition, FieldValueInput } from '@/components/objects/field-value-input'
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
import { Switch } from '@/components/ui/switch'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { DEFAULT_ORDER, DEFAULT_SORT } from '@/lib/objects-filter-model'
import { SAFE_METADATA_FIELD_NAME_RE } from '@maskin/shared'
import type { VisibilityState } from '@tanstack/react-table'
import {
	ArrowDown,
	ArrowUp,
	Check,
	ChevronDown,
	LayoutGrid,
	List as ListIcon,
	RotateCcw,
	SlidersHorizontal,
} from 'lucide-react'
import { useState } from 'react'

export interface DisplayPanelColumn {
	id: string
	label: string
	canHide: boolean
}

export type DisplayPanelView = 'list' | 'board'

/** Which single property the toolbar's value-chip row drives (mockup 932–937).
 *  The mockup also offers `Loop`; `ObjectResponse` carries no loop association,
 *  so that axis is omitted until the API grows one. */
export type DisplayPanelFilterAxis = 'status' | 'driver' | 'attention'

export const FILTER_BY_AXES: Array<{ id: DisplayPanelFilterAxis; label: string }> = [
	{ id: 'status', label: 'Status' },
	{ id: 'attention', label: 'Attention' },
	{ id: 'driver', label: 'Driver' },
]

export interface DisplayPanelProps {
	// View (List | Board)
	view?: DisplayPanelView
	onViewChange?: (view: DisplayPanelView) => void
	// Whether the active type supports board view (false hides Board and forces List)
	boardSupported?: boolean
	// FILTER BY — which property the toolbar chip row shows values for.
	filterBy?: DisplayPanelFilterAxis
	onFilterByChange?: (value: DisplayPanelFilterAxis) => void
	// Column visibility (Properties section)
	columns?: DisplayPanelColumn[]
	columnVisibility?: VisibilityState
	onColumnVisibilityChange?: (columnId: string, visible: boolean) => void
	// Ordering / Grouping pickers can be constrained to a subset of `columns`
	// (e.g. a non-table surface that shouldn't sort by every property).
	orderingColumns?: DisplayPanelColumn[]
	groupingColumns?: DisplayPanelColumn[]
	// Filters — comma-separated strings for multi-select
	statusFilter?: string
	onStatusFilterChange?: (value: string | undefined) => void
	statusesByType?: Record<string, string[]>
	driverFilter?: string
	onDriverFilterChange?: (value: string | undefined) => void
	actors?: ActorListItem[]
	// Metadata filters — one row per custom field definition of the active type.
	// The parent passes these only when exactly one object type is selected.
	fieldDefinitions?: FieldDefinition[]
	metadataFilters?: Record<string, string>
	onMetadataFilterChange?: (field: string, value: string | undefined) => void
	onResetFilters?: () => void
	// Ordering
	sort?: string
	onSortChange?: (value: string) => void
	order?: 'asc' | 'desc'
	onOrderChange?: (value: 'asc' | 'desc') => void
	// Grouping
	groupBy?: string
	onGroupByChange?: (value: string | undefined) => void
	// Show — per-view visibility flags. Callers opt in by wiring
	// `onIncludeArchivedChange`; when unset the whole section is hidden so
	// non-bet surfaces keep their existing panel.
	includeArchived?: boolean
	onIncludeArchivedChange?: (value: boolean) => void
	// Muted count rendered beside the "Show archived" label (mockup 964).
	archivedCount?: number
	// "Reset to default" — restores every display axis (filter/group/order/
	// show-in-list/show-archived) to defaults. Only rendered when wired; hidden
	// on consumers that don't opt in (same convention as the Show section).
	onResetToDefault?: () => void
	// Trigger appearance
	iconOnly?: boolean
	// Sections — surfaces that don't have a board view can opt out of the View pills.
	showView?: boolean
}

// The mockup's 9.5px mono section markers (931/940/948/956) — the `.eyebrow`
// utility already encodes exactly that treatment.
function SectionHeader({ children }: { children: React.ReactNode }) {
	return <p className="eyebrow">{children}</p>
}

// The mockup's PROPERTIES pill (line 710): borderless, fully rounded, filled
// with the muted surface when the property is shown and transparent when it is
// hidden. Deliberately not the bordered popover-picker treatment — a bordered
// pill reads as a button you press once, and this row is a set of toggles whose
// on/off state has to be legible at a glance across six of them.
function PropertyPill({
	active,
	onClick,
	children,
}: {
	active?: boolean
	onClick?: () => void
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				'inline-flex items-center rounded-full px-2.5 py-[3px] text-xs transition-colors',
				active
					? 'bg-muted font-semibold text-foreground'
					: 'font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
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
			<span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
			<div className="flex flex-1 items-center gap-1.5">
				{children}
				{trailing}
				<span className="sr-only">{value ?? placeholder}</span>
			</div>
		</div>
	)
}

const DROPDOWN_CLS = 'min-w-[10rem] max-h-64 overflow-y-auto'
const BOARD_MANUAL_SORT = 'boardOrder'

export function DisplayPanel({
	view = 'list',
	onViewChange,
	boardSupported = true,
	filterBy,
	onFilterByChange,
	columns = [],
	columnVisibility,
	onColumnVisibilityChange,
	orderingColumns: orderingColumnsOverride,
	groupingColumns: groupingColumnsOverride,
	statusFilter,
	onStatusFilterChange,
	statusesByType = {},
	driverFilter,
	onDriverFilterChange,
	actors,
	fieldDefinitions,
	metadataFilters,
	onMetadataFilterChange,
	onResetFilters,
	sort,
	onSortChange,
	order,
	onOrderChange,
	groupBy,
	onGroupByChange,
	includeArchived = false,
	onIncludeArchivedChange,
	archivedCount,
	onResetToDefault,
	iconOnly = false,
	showView = true,
}: DisplayPanelProps) {
	// Switching View closes the panel — on mobile it renders as a full-width
	// bottom Sheet that would otherwise sit on top of the just-switched-to
	// surface (e.g. Board), swallowing pointer events meant for it. The other
	// sections (Show/Filters/Sort) stay open on selection since users commonly
	// tweak several of those in one pass.
	const [open, setOpen] = useState(false)
	const handleViewChange = (next: DisplayPanelView) => {
		onViewChange?.(next)
		setOpen(false)
	}

	const activeStatuses = statusFilter ? statusFilter.split(',').filter(Boolean) : []
	const activeDrivers = driverFilter ? driverFilter.split(',').filter(Boolean) : []
	const metadataFields = fieldDefinitions ?? []
	// Fields whose name can't be inlined into a `metadata.<field>` filter (must
	// start with a letter, letters/numbers/underscores only — same rule the
	// backend enforces in extractMetadataFilters). Rendering a filter row for
	// one of these would look like it works, then have the typed value vanish
	// from the URL with no explanation the moment it's applied — excluded here
	// instead, with a visible note, so the limitation is never silent.
	const filterableMetadataFields = metadataFields.filter((field) =>
		SAFE_METADATA_FIELD_NAME_RE.test(field.name),
	)
	const unfilterableFieldCount = metadataFields.length - filterableMetadataFields.length
	// Counted from `metadataFilters` directly, not from `metadataFields` — the
	// active type's field rows (e.g. on the "All" tab, where `fieldDefinitions`
	// is undefined) can be empty while a metadata filter from another tab is
	// still applied. Gating the count on the rendered rows made that filter
	// invisible (no badge, no Reset) even though it kept narrowing results.
	const activeMetadataFilterCount = Object.values(metadataFilters ?? {}).filter(
		(value) => value !== '',
	).length
	const activeFilterCount =
		(activeStatuses.length > 0 ? 1 : 0) +
		(activeDrivers.length > 0 ? 1 : 0) +
		activeMetadataFilterCount +
		(includeArchived ? 1 : 0)
	const hasActiveFilters = activeFilterCount > 0
	const showShow = !!onIncludeArchivedChange

	const showMetadataFilters = !!onMetadataFilterChange && metadataFields.length > 0
	const showOrdering = !!sort && !!order && !!onSortChange && !!onOrderChange && columns.length > 0
	const showGrouping = !!onGroupByChange && columns.length > 0
	const showFilters =
		!!onStatusFilterChange ||
		!!onDriverFilterChange ||
		showMetadataFilters ||
		activeMetadataFilterCount > 0
	const hideableColumns = columns.filter((col) => col.canHide)
	const showProperties = !!onColumnVisibilityChange && hideableColumns.length > 0
	const activeOrderingColumns =
		orderingColumnsOverride && orderingColumnsOverride.length > 0
			? orderingColumnsOverride
			: columns
	const orderingColumns =
		view === 'board'
			? [{ id: BOARD_MANUAL_SORT, label: 'Manual', canHide: false }, ...activeOrderingColumns]
			: activeOrderingColumns
	const groupingColumns =
		groupingColumnsOverride && groupingColumnsOverride.length > 0
			? groupingColumnsOverride
			: columns

	const sortLabel = orderingColumns.find((c) => c.id === sort)?.label
	// Fallback for the trigger when the active sort isn't one of the offered
	// columns — name the route default rather than a hardcoded column.
	const defaultSortLabel = orderingColumns.find((c) => c.id === DEFAULT_SORT)?.label ?? DEFAULT_SORT
	const groupLabel = groupingColumns.find((c) => c.id === groupBy)?.label

	const typeEntries = Object.entries(statusesByType).filter(([, statuses]) => statuses.length > 0)
	const hasStatuses = typeEntries.length > 0

	const driverOptions = actors ?? []
	const hasOwners = driverOptions.length > 0

	function toggleStatus(status: string) {
		const next = activeStatuses.includes(status)
			? activeStatuses.filter((s) => s !== status)
			: [...activeStatuses, status]
		onStatusFilterChange?.(next.length > 0 ? next.join(',') : undefined)
	}

	function toggleDriver(driverId: string) {
		const next = activeDrivers.includes(driverId)
			? activeDrivers.filter((id) => id !== driverId)
			: [...activeDrivers, driverId]
		onDriverFilterChange?.(next.length > 0 ? next.join(',') : undefined)
	}

	const statusTriggerLabel =
		activeStatuses.length === 0
			? '+ Status'
			: activeStatuses.length === 1
				? activeStatuses[0]?.replace(/_/g, ' ')
				: `${activeStatuses.length} statuses`

	const driverTriggerLabel =
		activeDrivers.length === 0
			? '+ Driver'
			: activeDrivers.length === 1
				? (driverOptions.find((a) => a.id === activeDrivers[0])?.name ?? '1 driver')
				: `${activeDrivers.length} drivers`

	// Inline sort/group reading rendered as a sibling next to the Display
	// trigger — Linear's Display-options pattern. Filter chips communicate
	// hidden rows; sort/group are self-evident from the rendered list, so
	// they surface as a subtle text reading rather than another chip. Renders
	// only when non-default; collapses <640px so the toolbar stays clean on
	// mobile (the iconOnly variant already carries the filter count pill).
	const isNonDefaultSort = !!sort && (sort !== DEFAULT_SORT || order !== DEFAULT_ORDER)
	const hasGrouping = !!groupBy
	const showInlineReading = !iconOnly && (isNonDefaultSort || hasGrouping || includeArchived)
	const inlineSortLabel = sortLabel ?? sort
	const inlineGroupLabel = groupLabel ?? groupBy

	const trigger = (
		<ResponsivePopover open={open} onOpenChange={setOpen}>
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
					/* Mockup 692: a quiet text affordance with a caret, not a bordered
					   button. The active-filter count stays — the toolbar's removable
					   pills only cover the axes it renders, so this is the one place
					   a filter set from anywhere is always countable. */
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 px-3 text-xs font-semibold text-muted-foreground hover:text-foreground"
					>
						Display
						{hasActiveFilters && (
							<span className="rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
								{activeFilterCount}
							</span>
						)}
						<ChevronDown size={12} className="opacity-60" />
					</Button>
				)}
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent align="end" accessibleTitle="Display" className="md:w-80 md:p-0">
				<div className="min-h-0 overflow-y-auto md:max-h-[480px] text-left">
					{/* View — segmented List | Board rail (mockup 694–697). */}
					{showView && (
						<>
							<div className="p-1.5">
								<div className="flex gap-1 rounded-lg bg-muted p-1">
									<button
										type="button"
										aria-pressed={view === 'list'}
										onClick={() => handleViewChange('list')}
										className={cn(
											'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition-colors',
											view === 'list'
												? 'bg-background text-foreground shadow-xs'
												: 'text-muted-foreground hover:text-foreground',
										)}
									>
										<ListIcon size={15} aria-hidden="true" />
										List
									</button>
									<button
										type="button"
										aria-pressed={view === 'board'}
										disabled={!boardSupported}
										title={
											boardSupported
												? undefined
												: 'Board view needs configured statuses for this type'
										}
										onClick={boardSupported ? () => handleViewChange('board') : undefined}
										className={cn(
											'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition-colors',
											view === 'board'
												? 'bg-background text-foreground shadow-xs'
												: 'text-muted-foreground hover:text-foreground',
											!boardSupported && 'cursor-not-allowed opacity-50',
										)}
									>
										<LayoutGrid size={15} aria-hidden="true" />
										Board
									</button>
								</div>
							</div>
							<Separator />
						</>
					)}

					{/* FILTER BY — which single property the toolbar chip row drives. */}
					{onFilterByChange && (
						<>
							<div className="p-1.5">
								<div className="px-2.5 pt-1 pb-1">
									<SectionHeader>Filter by</SectionHeader>
								</div>
								{FILTER_BY_AXES.map((axis) => (
									<button
										key={axis.id}
										type="button"
										aria-pressed={filterBy === axis.id}
										onClick={() => onFilterByChange(axis.id)}
										className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
									>
										<span
											className={cn(
												'min-w-0 flex-1 truncate',
												filterBy === axis.id ? 'font-semibold text-foreground' : 'text-foreground',
											)}
										>
											{axis.label}
										</span>
										{filterBy === axis.id && <Check size={12} className="opacity-60" />}
									</button>
								))}
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
											className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
											onClick={() => {
												if (onResetFilters) {
													onResetFilters()
												} else {
													onStatusFilterChange?.(undefined)
													onDriverFilterChange?.(undefined)
													for (const f of metadataFields) {
														onMetadataFilterChange?.(f.name, undefined)
													}
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
										<span className="w-16 shrink-0 text-xs text-muted-foreground">Status</span>
										<DropdownMenu>
											<DropdownMenuTrigger asChild disabled={!hasStatuses}>
												<Button
													variant={activeStatuses.length > 0 ? 'outline' : 'ghost'}
													size="sm"
													className={cn(
														'h-7 gap-1.5 px-2 text-xs',
														activeStatuses.length === 0 &&
															'text-muted-foreground hover:text-foreground',
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
														<DropdownMenuLabel className="capitalize text-xs font-medium text-muted-foreground py-1">
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
												className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
											>
												Clear
											</button>
										)}
									</div>
								)}

								{/* Filter by Driver */}
								{onDriverFilterChange && (
									<div className="flex items-center gap-2">
										<span className="w-16 shrink-0 text-xs text-muted-foreground">Driver</span>
										<DropdownMenu>
											<DropdownMenuTrigger asChild disabled={!hasOwners}>
												<Button
													variant={activeDrivers.length > 0 ? 'outline' : 'ghost'}
													size="sm"
													className={cn(
														'h-7 gap-1.5 px-2 text-xs',
														activeDrivers.length === 0 &&
															'text-muted-foreground hover:text-foreground',
													)}
												>
													<span className="truncate">{driverTriggerLabel}</span>
													{hasOwners && <ChevronDown size={12} className="shrink-0 opacity-60" />}
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="start" className={DROPDOWN_CLS}>
												{driverOptions.map((actor) => (
													<DropdownMenuCheckboxItem
														key={actor.id}
														checked={activeDrivers.includes(actor.id)}
														onCheckedChange={() => toggleDriver(actor.id)}
													>
														{actor.name}
													</DropdownMenuCheckboxItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>
										{activeDrivers.length > 0 && (
											<button
												type="button"
												aria-label="Clear Driver filter"
												title="Clear Driver filter"
												onClick={() => onDriverFilterChange?.(undefined)}
												className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
											>
												Clear
											</button>
										)}
									</div>
								)}

								{/* Metadata filters — one row per custom field of the active type */}
								{showMetadataFilters &&
									filterableMetadataFields.map((field) => {
										const current = metadataFilters?.[field.name] ?? ''
										return (
											<div key={field.name} className="flex items-center gap-2">
												<span
													className="w-16 shrink-0 truncate text-xs capitalize text-muted-foreground"
													title={field.name}
												>
													{field.name.replace(/_/g, ' ')}
												</span>
												<FieldValueInput
													type={field.type}
													fieldDef={field}
													value={current}
													onChange={(value) =>
														onMetadataFilterChange?.(field.name, value || undefined)
													}
													placeholder="Any"
													className="flex-1"
												/>
												{current !== '' && (
													<button
														type="button"
														aria-label={`Clear ${field.name} filter`}
														title={`Clear ${field.name} filter`}
														onClick={() => onMetadataFilterChange?.(field.name, undefined)}
														className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
													>
														Clear
													</button>
												)}
											</div>
										)
									})}
								{unfilterableFieldCount > 0 && (
									<p className="text-[11px] text-muted-foreground">
										{unfilterableFieldCount} field{unfilterableFieldCount === 1 ? '' : 's'} can't be
										filtered — field names must start with a letter and contain only letters,
										numbers, and underscores.
									</p>
								)}
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
											{groupingColumns.map((col) => (
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
												<span className="truncate capitalize">{sortLabel ?? defaultSortLabel}</span>
												<ChevronDown size={12} className="shrink-0 opacity-60" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="start" className={DROPDOWN_CLS}>
											{orderingColumns.map((col) => (
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
									{sort !== BOARD_MANUAL_SORT && (
										<button
											type="button"
											aria-label={order === 'asc' ? 'Ascending' : 'Descending'}
											title={order === 'asc' ? 'Ascending' : 'Descending'}
											onClick={() => onOrderChange?.(order === 'asc' ? 'desc' : 'asc')}
											className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
										>
											{order === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
										</button>
									)}
								</PickerRow>
							</div>
							<Separator />
						</>
					)}

					{/* PROPERTIES — a wrapped row of toggle pills (mockup 709–712).
					 * One pill per hideable column; filled = shown in the list. */}
					{showProperties && (
						<>
							<div className="p-1.5">
								<div className="px-2.5 pt-1 pb-1">
									<SectionHeader>Properties</SectionHeader>
								</div>
								<div
									data-testid="display-properties"
									className="flex flex-wrap gap-1 px-2.5 pt-0.5 pb-1.5"
								>
									{hideableColumns.map((col) => {
										const isVisible = columnVisibility?.[col.id] !== false
										return (
											<PropertyPill
												key={col.id}
												active={isVisible}
												onClick={() => onColumnVisibilityChange?.(col.id, !isVisible)}
											>
												<span className="capitalize">{col.label}</span>
											</PropertyPill>
										)
									})}
								</div>
							</div>
							<Separator />
						</>
					)}

					{/* Show archived — the archived count sits between the label and
					 * the switch (mockup 964). Only renders when the caller wires
					 * `onIncludeArchivedChange`, so non-bet surfaces keep their shape. */}
					{showShow && (
						<div className="p-1.5">
							<label
								htmlFor="display-include-archived"
								className={cn(
									// `relative` anchors the invisible `::before` hit surface so
									// the visible row stays compact while the tap target meets
									// 44 px — iOS/mobile canon.
									'relative flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-accent',
									"before:absolute before:inset-x-0 before:top-1/2 before:h-11 before:-translate-y-1/2 before:content-['']",
								)}
							>
								<span className="text-foreground">Show archived</span>
								{archivedCount !== undefined && (
									<span className="tabular-nums text-muted-foreground">{archivedCount}</span>
								)}
								<Switch
									id="display-include-archived"
									checked={includeArchived}
									onCheckedChange={(next) => onIncludeArchivedChange?.(next)}
									aria-label="Show archived"
									className="ml-auto"
								/>
							</label>
						</div>
					)}

					{/* Reset all — restores every display axis. Always the final row
						(mockup 716), with the muted "auto-saves" note that tells the
						operator these choices persist without an explicit Save. */}
					{onResetToDefault && (
						<>
							<Separator />
							<div className="p-1">
								<button
									type="button"
									onClick={onResetToDefault}
									className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									<RotateCcw size={12} aria-hidden="true" />
									<span className="flex-1">Reset all</span>
									<span className="text-[10.5px] text-border-strong">auto-saves</span>
								</button>
							</div>
						</>
					)}
				</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)

	// Keep a stable wrapper regardless of `showInlineReading`. Switching the
	// returned root between `trigger` and `<div>{trigger}…</div>` would tear
	// down and remount the ResponsivePopover subtree — a toggle inside the
	// panel (e.g. Include archived) that flips `showInlineReading` would
	// close the panel mid-interaction because the internal open state lives
	// in the primitive that just got unmounted.
	return (
		<div className="inline-flex items-center gap-2">
			{trigger}
			{showInlineReading && (
				<span
					className="hidden sm:inline-flex items-center gap-1 text-xs"
					aria-label="Active display settings"
				>
					{isNonDefaultSort && (
						<>
							<span className="capitalize text-foreground">{inlineSortLabel}</span>
							{order === 'asc' ? (
								<ArrowUp size={12} className="text-foreground" />
							) : (
								<ArrowDown size={12} className="text-foreground" />
							)}
						</>
					)}
					{isNonDefaultSort && hasGrouping && <span className="text-muted-foreground">·</span>}
					{hasGrouping && (
						<>
							<span className="text-muted-foreground">grouped by</span>
							<span className="capitalize text-foreground">{inlineGroupLabel}</span>
						</>
					)}
					{(isNonDefaultSort || hasGrouping) && includeArchived && (
						<span className="text-muted-foreground">·</span>
					)}
					{includeArchived && <span className="text-foreground">+ archived</span>}
				</span>
			)}
		</div>
	)
}
