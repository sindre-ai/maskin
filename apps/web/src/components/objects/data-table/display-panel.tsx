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
import { SAFE_METADATA_FIELD_NAME_RE } from '@maskin/shared'
import type { VisibilityState } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, Check, ChevronDown, SlidersHorizontal } from 'lucide-react'

export interface DisplayPanelColumn {
	id: string
	label: string
	canHide: boolean
}

export type DisplayPanelView = 'list' | 'board'

export interface DisplayPanelProps {
	// View (List | Board)
	view?: DisplayPanelView
	onViewChange?: (view: DisplayPanelView) => void
	// Whether the active type supports board view (false hides Board and forces List)
	boardSupported?: boolean
	// Column visibility (Properties section)
	columns?: DisplayPanelColumn[]
	columnVisibility?: VisibilityState
	onColumnVisibilityChange?: (columnId: string, visible: boolean) => void
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
	// Trigger appearance
	iconOnly?: boolean
	// Sections — surfaces that don't have a board view can opt out of the View pills.
	showView?: boolean
}

function SectionHeader({ children }: { children: React.ReactNode }) {
	return (
		<p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
			{children}
		</p>
	)
}

// Bordered picker toggle used inside this popover (View, Properties). The
// `border-accent bg-accent text-accent-foreground` active state is reserved for
// picker toggles inside popovers. Filter state that lives in the page toolbar
// (FilterTabs active, FilterChip) uses the plain `bg-muted text-foreground
// font-medium` style instead.
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
const BOARD_MANUAL_SORT = 'boardOrder'

export function DisplayPanel({
	view = 'list',
	onViewChange,
	boardSupported = true,
	columns = [],
	columnVisibility,
	onColumnVisibilityChange,
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
	iconOnly = false,
	showView = true,
}: DisplayPanelProps) {
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
	const orderingColumns =
		view === 'board'
			? [{ id: BOARD_MANUAL_SORT, label: 'Manual', canHide: false }, ...columns]
			: columns

	const sortLabel = orderingColumns.find((c) => c.id === sort)?.label
	const groupLabel = columns.find((c) => c.id === groupBy)?.label

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
	const isNonDefaultSort = !!sort && (sort !== 'createdAt' || order !== 'desc')
	const hasGrouping = !!groupBy
	const showInlineReading = !iconOnly && (isNonDefaultSort || hasGrouping || includeArchived)
	const inlineSortLabel = sortLabel ?? sort
	const inlineGroupLabel = groupLabel ?? groupBy

	const trigger = (
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
				<div className="min-h-0 overflow-y-auto md:max-h-[480px] text-left">
					{/* View */}
					{showView && (
						<>
							<div className="p-3 space-y-2">
								<SectionHeader>View</SectionHeader>
								<div className="flex items-center gap-1.5">
									<PillButton active={view === 'list'} onClick={() => onViewChange?.('list')}>
										List
									</PillButton>
									<PillButton
										active={view === 'board'}
										disabled={!boardSupported}
										onClick={boardSupported ? () => onViewChange?.('board') : undefined}
										title={
											boardSupported
												? undefined
												: 'Board view needs configured statuses for this type'
										}
									>
										Board
									</PillButton>
								</div>
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
												<span className="truncate capitalize">{sortLabel ?? 'Created'}</span>
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
											className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-secondary hover:text-foreground hover:border-border-hover transition-colors"
										>
											{order === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
										</button>
									)}
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

					{/* Show — per-view visibility flags (Include archived, ...). Only
					 * renders when the caller wires `onIncludeArchivedChange`, so
					 * non-bet surfaces keep their existing panel shape. */}
					{showShow && (
						<>
							<div className="p-3 space-y-2">
								<SectionHeader>Show</SectionHeader>
								<label
									htmlFor="display-include-archived"
									className={cn(
										// `relative` anchors the invisible `::before` hit surface
										// so the visible row stays compact while the tap target
										// meets 44 px — iOS/mobile canon.
										'relative flex items-center justify-between gap-2 text-xs cursor-pointer',
										"before:absolute before:-inset-3 before:h-11 before:w-full before:content-[''] before:pointer-events-none",
									)}
								>
									<span className="text-foreground">Include archived</span>
									<Switch
										id="display-include-archived"
										checked={includeArchived}
										onCheckedChange={(next) => onIncludeArchivedChange?.(next)}
										aria-label="Include archived"
									/>
								</label>
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

								{/* Filter by Driver */}
								{onDriverFilterChange && (
									<div className="flex items-center gap-2">
										<span className="w-16 shrink-0 text-xs text-text-secondary">Driver</span>
										<DropdownMenu>
											<DropdownMenuTrigger asChild disabled={!hasOwners}>
												<Button
													variant={activeDrivers.length > 0 ? 'outline' : 'ghost'}
													size="sm"
													className={cn(
														'h-7 gap-1.5 px-2 text-xs',
														activeDrivers.length === 0 &&
															'text-text-secondary hover:text-foreground',
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
												className="text-[11px] text-text-secondary hover:text-foreground transition-colors"
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
													className="w-16 shrink-0 truncate text-xs capitalize text-text-secondary"
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
														className="text-[11px] text-text-secondary hover:text-foreground transition-colors"
													>
														Clear
													</button>
												)}
											</div>
										)
									})}
								{unfilterableFieldCount > 0 && (
									<p className="text-[11px] text-text-secondary">
										{unfilterableFieldCount} field{unfilterableFieldCount === 1 ? '' : 's'} can't be
										filtered — field names must start with a letter and contain only letters,
										numbers, and underscores.
									</p>
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

	if (!showInlineReading) return trigger

	return (
		<div className="inline-flex items-center gap-2">
			{trigger}
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
		</div>
	)
}
