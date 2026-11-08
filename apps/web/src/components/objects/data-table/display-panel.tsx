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
import { Check, ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { forwardRef, useMemo, useState } from 'react'
import { DisplayFilterSection, type DisplayFilterSectionModel } from './display-filter-section'

export interface DisplayPanelColumn {
	id: string
	label: string
	canHide: boolean
}

export type DisplayPanelView = 'list' | 'board'

/** One entry of a custom View rail (replaces the built-in List | Board pair). */
export interface DisplayPanelViewChoice {
	id: string
	label: string
	icon?: React.ReactNode
}

export interface DisplayPanelProps {
	// View (List | Board)
	view?: DisplayPanelView
	onViewChange?: (view: DisplayPanelView) => void
	// Whether the active type supports board view (false hides Board and forces List)
	boardSupported?: boolean
	// FILTERS — collapsible axis rows, built by the caller so the same models
	// also drive the toolbar's pinned-chip row.
	filterSections?: DisplayFilterSectionModel[]
	pinnedFilters?: string[]
	onTogglePinnedFilter?: (token: string) => void
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
	// Sections — surfaces that don't have a board view can opt out of the View pills.
	showView?: boolean
	// Custom View rail (e.g. For you: Cards | List). When set it replaces the
	// built-in List | Board pair; selection is driven by `viewChoice` and reported
	// through `onViewChoiceChange`.
	viewChoices?: DisplayPanelViewChoice[]
	viewChoice?: string
	onViewChoiceChange?: (id: string) => void
	// Heading of the FILTERS block ("Filters" by default; For you reads "Show").
	filtersLabel?: string
	// Text of the small button beside the FILTERS heading ("Reset" by default;
	// the design reads "Reset filters").
	resetFiltersLabel?: string
	// Text of the footer row ("Reset all" by default; the design reads "Reset display").
	resetLabel?: string
	// Overrides the count on the trigger and the "has active filters" state, for
	// callers whose filters live only in `filterSections`.
	activeFilterCount?: number
}

// Section marker: 11px bold uppercase sans in a 32px row (design: ORDERING,
// GROUPING, FILTERS, PROPERTIES). Kept as one shared header so every section
// reads the same.
function SectionHeader({ children }: { children: React.ReactNode }) {
	return (
		<p className="flex h-8 items-center px-2.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
			{children}
		</p>
	)
}

// Every row of the panel is a plain menu row: 36px on pointer devices, 44px on
// touch, label left, value right.
const ROW_CLS =
	'flex h-11 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted md:h-9 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent'

// `Label … value ▾`. Forwards its ref and props so it can be a DropdownMenu
// trigger (the value pickers) or a plain button (the Order toggle).
const ValueRow = forwardRef<
	HTMLButtonElement,
	React.ComponentPropsWithoutRef<'button'> & {
		label: string
		value: string
		caret?: React.ReactNode
	}
>(({ label, value, caret, className, ...props }, ref) => (
	<button ref={ref} type="button" className={cn(ROW_CLS, className)} {...props}>
		<span className="shrink-0">{label}</span>
		<span className="flex-1" />
		<span className="min-w-0 truncate text-xs font-medium text-muted-foreground first-letter:uppercase">
			{value}
		</span>
		{caret ?? <ChevronDown size={10} aria-hidden="true" className="shrink-0 opacity-60" />}
	</button>
))
ValueRow.displayName = 'ValueRow'

// A row with a brand check on the left while on (View rows, Properties).
function CheckRow({
	checked,
	hint,
	children,
	...props
}: React.ComponentPropsWithoutRef<'button'> & { checked: boolean; hint?: string }) {
	return (
		<button type="button" aria-pressed={checked} className={ROW_CLS} {...props}>
			<span className="flex w-4 shrink-0 justify-center text-brand">
				{checked && <Check size={14} aria-hidden="true" />}
			</span>
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{hint && <span className="shrink-0 text-xs font-medium text-muted-foreground">{hint}</span>}
		</button>
	)
}

// "Newest first" reads right for a date column; anything else is a plain
// ascending/descending reading.
const DATE_SORT_RE = /(at|date|created|updated|activity|latest|seen)$/i
function orderLabel(sort: string | undefined, order: 'asc' | 'desc' | undefined): string {
	const date = !!sort && DATE_SORT_RE.test(sort)
	if (order === 'asc') return date ? 'Oldest first ↑' : 'Ascending ↑'
	return date ? 'Newest first ↓' : 'Descending ↓'
}

const DROPDOWN_CLS = 'min-w-[10rem] max-h-64 overflow-y-auto'
const BOARD_MANUAL_SORT = 'boardOrder'

export function DisplayPanel({
	view = 'list',
	onViewChange,
	boardSupported = true,
	filterSections,
	pinnedFilters,
	onTogglePinnedFilter,
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
	showView = true,
	viewChoices,
	viewChoice,
	onViewChoiceChange,
	filtersLabel = 'Filters',
	resetFiltersLabel = 'Reset',
	resetLabel = 'Reset all',
	activeFilterCount: activeFilterCountOverride,
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
		activeFilterCountOverride ??
		(activeStatuses.length > 0 ? 1 : 0) +
			(activeDrivers.length > 0 ? 1 : 0) +
			activeMetadataFilterCount +
			(includeArchived ? 1 : 0)
	const hasActiveFilters = activeFilterCount > 0
	const pinnedTokenSet = useMemo(() => new Set(pinnedFilters ?? []), [pinnedFilters])
	const showShow = !!onIncludeArchivedChange

	const showMetadataFilters = !!onMetadataFilterChange && metadataFields.length > 0
	const showOrdering = !!sort && !!order && !!onSortChange && !!onOrderChange && columns.length > 0
	const showGrouping = !!onGroupByChange && columns.length > 0
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

	const trigger = (
		<ResponsivePopover open={open} onOpenChange={setOpen}>
			<ResponsivePopoverTrigger asChild>
				{/* The title-row Display control (design): a 32px ringed circle with a sliders
				    glyph, at every width. The active-filter count stays as a badge — the
				    toolbar's removable pills only cover the axes it renders, so this is the
				    one place a filter set from anywhere is always countable. */}
				<Button
					variant="ghost"
					size="icon"
					className="relative h-8 w-8 shrink-0 rounded-full border border-border bg-background text-foreground hover:bg-accent"
					title="Display"
					aria-label="Display"
				>
					<SlidersHorizontal size={14} aria-hidden="true" />
					{hasActiveFilters && (
						<span className="absolute -top-0.5 -right-0.5 rounded-full bg-primary text-primary-foreground text-[10px] leading-none px-1 py-0.5 min-w-[14px] text-center">
							{activeFilterCount}
						</span>
					)}
				</Button>
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent
				align="end"
				accessibleTitle="Display"
				className="md:w-87.5 md:rounded-xl md:p-1.25 md:shadow-lg"
			>
				<div className="min-h-0 overflow-y-auto text-left md:max-h-112">
					{/* View — two rows with a check on the active one. */}
					{showView && viewChoices && viewChoices.length > 0 && (
						<>
							<div>
								{viewChoices.map((choice) => (
									<CheckRow
										key={choice.id}
										checked={viewChoice === choice.id}
										onClick={() => {
											onViewChoiceChange?.(choice.id)
											setOpen(false)
										}}
									>
										View: {choice.label}
									</CheckRow>
								))}
							</div>
							<Separator className="my-1" />
						</>
					)}
					{showView && !viewChoices && (
						<>
							<div>
								<CheckRow checked={view === 'list'} onClick={() => handleViewChange('list')}>
									View: List
								</CheckRow>
								<CheckRow
									checked={view === 'board'}
									disabled={!boardSupported}
									hint={boardSupported ? undefined : 'needs one type with statuses'}
									title={
										boardSupported
											? undefined
											: 'Board view needs configured statuses for this type'
									}
									onClick={boardSupported ? () => handleViewChange('board') : undefined}
								>
									View: Board
								</CheckRow>
							</div>
							<Separator className="my-1" />
						</>
					)}

					{/* Ordering */}
					{showOrdering && (
						<>
							<div>
								<SectionHeader>Ordering</SectionHeader>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<ValueRow label="Sort by" value={sortLabel ?? defaultSortLabel} />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className={DROPDOWN_CLS}>
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
									<ValueRow
										label="Order"
										value={orderLabel(sort, order)}
										caret={<span />}
										aria-label={`Order, ${order === 'asc' ? 'ascending' : 'descending'}`}
										title={order === 'asc' ? 'Ascending' : 'Descending'}
										onClick={() => onOrderChange?.(order === 'asc' ? 'desc' : 'asc')}
									/>
								)}
							</div>
							<Separator className="my-1" />
						</>
					)}

					{/* Grouping */}
					{showGrouping && (
						<>
							<div>
								<SectionHeader>Grouping</SectionHeader>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<ValueRow label="Group by" value={groupLabel ?? 'None'} />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className={DROPDOWN_CLS}>
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
							</div>
							<Separator className="my-1" />
						</>
					)}

					{/* FILTERS — one `Label … value ▾` row per axis, each expanding into
					 * its values with counts and a Pin control. Pinning is what lets this
					 * panel stay closed: the filters an operator actually reaches for
					 * graduate to the toolbar's chip row. */}
					{((filterSections?.length ?? 0) > 0 ||
						showMetadataFilters ||
						activeMetadataFilterCount > 0 ||
						// Legacy consumers drive status/driver straight off these callbacks.
						(!filterSections?.length && (!!onStatusFilterChange || !!onDriverFilterChange))) && (
						<>
							<div>
								<div className="flex items-center justify-between pr-2.5">
									<SectionHeader>{filtersLabel}</SectionHeader>
									{hasActiveFilters && onResetFilters && (
										<button
											type="button"
											className="text-xs text-muted-foreground transition-colors hover:text-foreground"
											onClick={onResetFilters}
										>
											{resetFiltersLabel}
										</button>
									)}
								</div>
								{/* Legacy value pickers, for consumers that have not moved to
								    `filterSections` yet. Rendered only in their absence so the
								    two never stack. */}
								{!filterSections?.length && onStatusFilterChange && (
									<div className="flex items-center">
										<DropdownMenu>
											<DropdownMenuTrigger asChild disabled={!hasStatuses}>
												<ValueRow
													label="Status"
													value={
														activeStatuses.length === 0 ? 'Any' : (statusTriggerLabel ?? 'Any')
													}
													caret={hasStatuses ? undefined : <span />}
												/>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" className={DROPDOWN_CLS}>
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
												className="shrink-0 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
											>
												Clear
											</button>
										)}
									</div>
								)}
								{!filterSections?.length && onDriverFilterChange && (
									<div className="flex items-center">
										<DropdownMenu>
											<DropdownMenuTrigger asChild disabled={!hasOwners}>
												<ValueRow
													label="Driver"
													value={activeDrivers.length === 0 ? 'Any' : driverTriggerLabel}
													caret={hasOwners ? undefined : <span />}
												/>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" className={DROPDOWN_CLS}>
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
												className="shrink-0 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
											>
												Clear
											</button>
										)}
									</div>
								)}
								{(filterSections ?? []).map((section) => (
									<DisplayFilterSection
										key={section.id}
										section={section}
										pinnedTokens={pinnedTokenSet}
										onTogglePin={onTogglePinnedFilter}
									/>
								))}
								{/* Custom-field filters — one row per workspace-defined field of
								    the active type. A free-text or date field has no enumerable
								    set of options to list, count, or pin, so these keep the
								    value-input shape rather than the option lists above. */}
								{showMetadataFilters &&
									filterableMetadataFields.map((field) => {
										const current = metadataFilters?.[field.name] ?? ''
										return (
											<div key={field.name} className="flex items-center gap-2 px-2.5 py-1">
												<span
													className="w-16 shrink-0 truncate text-sm font-medium capitalize text-foreground"
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
														className="text-xs text-muted-foreground transition-colors hover:text-foreground"
													>
														Clear
													</button>
												)}
											</div>
										)
									})}
								{unfilterableFieldCount > 0 && (
									<p className="px-2.5 pb-1 text-xs text-muted-foreground">
										{unfilterableFieldCount} field{unfilterableFieldCount === 1 ? '' : 's'} can't be
										filtered — field names must start with a letter and contain only letters,
										numbers, and underscores.
									</p>
								)}
							</div>
							<Separator className="my-1" />
						</>
					)}

					{/* PROPERTIES — one check row per hideable column. */}
					{showProperties && (
						<>
							<div>
								<SectionHeader>Properties</SectionHeader>
								<div data-testid="display-properties">
									{hideableColumns.map((col) => {
										const isVisible = columnVisibility?.[col.id] !== false
										return (
											<CheckRow
												key={col.id}
												checked={isVisible}
												onClick={() => onColumnVisibilityChange?.(col.id, !isVisible)}
											>
												<span className="capitalize">{col.label}</span>
											</CheckRow>
										)
									})}
								</div>
							</div>
							<Separator className="my-1" />
						</>
					)}

					{/* Show archived — the archived count sits between the label and the
					 * switch. Only renders when the caller wires `onIncludeArchivedChange`,
					 * so other surfaces keep their shape. */}
					{showShow && (
						<div>
							<label
								htmlFor="display-include-archived"
								className={cn(
									'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm font-medium transition-colors hover:bg-muted',
									'h-11 md:h-9',
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

					{/* Reset — restores every display axis. Always the final row, with
					 * the muted "auto-saves" note that tells the operator these choices
					 * persist without an explicit Save. */}
					{onResetToDefault && (
						<>
							<Separator className="my-1" />
							<button
								type="button"
								onClick={onResetToDefault}
								className={cn(ROW_CLS, 'text-muted-foreground hover:text-foreground')}
							>
								<RotateCcw size={12} aria-hidden="true" />
								<span className="flex-1">{resetLabel}</span>
								<span className="text-xs font-normal text-muted-foreground">auto-saves</span>
							</button>
						</>
					)}
				</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)

	// The wrapper stays so callers' layout assumptions hold.
	return <div className="inline-flex items-center gap-2">{trigger}</div>
}
