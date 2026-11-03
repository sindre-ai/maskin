import type { FieldDefinition } from '@/components/objects/field-value-input'
import { FilterChip } from '@/components/shared/filter-chip'
import { Button } from '@/components/ui/button'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { VisibilityState } from '@tanstack/react-table'
import type { ColumnInfo } from './data-table-controls'
import type { DisplayFilterSectionModel } from './display-filter-section'
import { DisplayPanel, type DisplayPanelView } from './display-panel'

/** A filter the user pinned out of the Display panel — a one-click toggle in
 *  the control row (mockup 659–662). */
export interface ToolbarQuickChip {
	id: string
	label: string
	active: boolean
	onToggle: () => void
}

/** One removable filter pill in the control row (mockup 914–918). */
export interface ToolbarFilterPill {
	id: string
	label: string
	value: string
	onRemove: () => void
}

interface DataTableToolbarProps {
	// Column visibility
	columns: ColumnInfo[]
	columnVisibility: VisibilityState
	onColumnVisibilityChange: (columnId: string, visible: boolean) => void
	// Filters the user pinned out of the Display panel, in pin order.
	quickChips?: ToolbarQuickChip[]
	// Removable pills for every active filter, plus the Clear all escape hatch.
	filterPills?: ToolbarFilterPill[]
	onClearAllFilters?: () => void
	// Collapsible FILTERS sections rendered inside the Display panel. Built by
	// the caller so the same models drive both the panel rows and `quickChips`.
	filterSections?: DisplayFilterSectionModel[]
	pinnedFilters?: string[]
	onTogglePinnedFilter?: (token: string) => void
	// Display panel props
	statusFilter?: string
	onStatusFilterChange: (value: string | undefined) => void
	statusesByType: Record<string, string[]>
	driverFilter?: string
	onDriverFilterChange: (value: string | undefined) => void
	actors?: ActorListItem[]
	fieldDefinitions?: FieldDefinition[]
	metadataFilters?: Record<string, string>
	onMetadataFilterChange?: (field: string, value: string | undefined) => void
	onResetFilters?: () => void
	sort: string
	onSortChange: (value: string) => void
	order: 'asc' | 'desc'
	onOrderChange: (value: 'asc' | 'desc') => void
	groupBy?: string
	onGroupByChange: (value: string | undefined) => void
	// Show — per-view visibility flags. Only surfaced when the caller opts in.
	includeArchived?: boolean
	onIncludeArchivedChange?: (value: boolean) => void
	archivedCount?: number
	// Reset every display axis to defaults. Only surfaced when the caller opts in.
	onResetToDefault?: () => void
	// View switcher
	view?: DisplayPanelView
	onViewChange?: (view: DisplayPanelView) => void
	boardSupported?: boolean
}

export function DataTableToolbar({
	columns,
	columnVisibility,
	onColumnVisibilityChange,
	quickChips = [],
	filterPills = [],
	onClearAllFilters,
	filterSections,
	pinnedFilters,
	onTogglePinnedFilter,
	statusFilter,
	onStatusFilterChange,
	statusesByType,
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
	includeArchived,
	onIncludeArchivedChange,
	archivedCount,
	onResetToDefault,
	view,
	onViewChange,
	boardSupported,
}: DataTableToolbarProps) {
	// "Clear all" only earns its place once more than one pill is active —
	// with a single pill its own × already does the job (mockup 920).
	const showClearAll = !!onClearAllFilters && filterPills.length > 1

	return (
		// One control row: pinned chips, then a pill per active filter, then the
		// Display panel pushed to the right edge (mockup 658–673). Wraps rather
		// than scrolls — a chip that scrolled out of view would read as absent,
		// and "absent filter" is the one thing this row exists to disprove.
		<div className="flex min-h-7 flex-none flex-wrap items-center gap-1 px-0.5 gap-y-1.5">
			{quickChips.map((chip) => (
				<button
					key={chip.id}
					type="button"
					aria-pressed={chip.active}
					onClick={chip.onToggle}
					className={cn(
						'inline-flex h-[26px] shrink-0 items-center whitespace-nowrap rounded-md px-2.5',
						'text-[11.5px] transition-colors hover:bg-muted hover:text-foreground',
						chip.active
							? 'bg-muted font-bold text-foreground'
							: 'font-semibold text-muted-foreground',
					)}
				>
					{chip.label}
				</button>
			))}

			{filterPills.map((pill) => (
				<FilterChip
					key={pill.id}
					label={pill.label}
					value={pill.value}
					onRemove={pill.onRemove}
					className="shrink-0"
				/>
			))}

			{showClearAll && (
				<Button
					variant="ghost"
					size="sm"
					title="Clear all filters"
					className="h-[26px] shrink-0 px-1 text-[11.5px] font-semibold text-muted-foreground hover:text-foreground"
					onClick={onClearAllFilters}
				>
					Clear all
				</Button>
			)}

			<span className="ml-auto" />

			<DisplayPanel
				view={view}
				onViewChange={onViewChange}
				boardSupported={boardSupported}
				columns={columns}
				columnVisibility={columnVisibility}
				onColumnVisibilityChange={onColumnVisibilityChange}
				statusFilter={statusFilter}
				onStatusFilterChange={onStatusFilterChange}
				statusesByType={statusesByType}
				driverFilter={driverFilter}
				onDriverFilterChange={onDriverFilterChange}
				actors={actors}
				fieldDefinitions={fieldDefinitions}
				metadataFilters={metadataFilters}
				onMetadataFilterChange={onMetadataFilterChange}
				onResetFilters={onResetFilters}
				sort={sort}
				onSortChange={onSortChange}
				order={order}
				onOrderChange={onOrderChange}
				groupBy={groupBy}
				onGroupByChange={onGroupByChange}
				includeArchived={includeArchived}
				onIncludeArchivedChange={onIncludeArchivedChange}
				archivedCount={archivedCount}
				onResetToDefault={onResetToDefault}
				filterSections={filterSections}
				pinnedFilters={pinnedFilters}
				onTogglePinnedFilter={onTogglePinnedFilter}
			/>
		</div>
	)
}
