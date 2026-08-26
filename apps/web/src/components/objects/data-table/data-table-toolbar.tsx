import type { FieldDefinition } from '@/components/objects/field-value-input'
import { FilterChip } from '@/components/shared/filter-chip'
import { type FilterTabItem, FilterTabs } from '@/components/shared/filter-tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import type { ActorListItem } from '@/lib/api'
import type { VisibilityState } from '@tanstack/react-table'
import { Search, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ColumnInfo } from './data-table-controls'
import { DisplayPanel, type DisplayPanelFilterAxis, type DisplayPanelView } from './display-panel'

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
	// Value chips for the active FILTER BY axis (mockup 907–911). Single-select:
	// picking a chip narrows to that one value; picking it again clears the axis.
	// Multi-select stays available through the Display panel's own pickers.
	axisChips?: FilterTabItem<string | undefined>[]
	axisValue?: string
	onAxisValueChange?: (value: string | undefined) => void
	axisLabel?: string
	// Removable pills for every active filter, plus the Clear all escape hatch.
	filterPills?: ToolbarFilterPill[]
	onClearAllFilters?: () => void
	// FILTER BY axis picker (lives inside the Display panel)
	filterBy?: DisplayPanelFilterAxis
	onFilterByChange?: (value: DisplayPanelFilterAxis) => void
	// Search
	search?: string
	onSearchChange: (value: string) => void
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
	// Import
	onImportClick: () => void
}

export function DataTableToolbar({
	columns,
	columnVisibility,
	onColumnVisibilityChange,
	axisChips = [],
	axisValue,
	onAxisValueChange,
	axisLabel = 'Filter values',
	filterPills = [],
	onClearAllFilters,
	filterBy,
	onFilterByChange,
	search,
	onSearchChange,
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
	onImportClick,
}: DataTableToolbarProps) {
	const [localSearch, setLocalSearch] = useState(search ?? '')
	const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

	useEffect(() => {
		setLocalSearch(search ?? '')
	}, [search])

	useEffect(() => {
		return () => clearTimeout(debounceRef.current)
	}, [])

	const handleSearchChange = (value: string) => {
		setLocalSearch(value)
		clearTimeout(debounceRef.current)
		debounceRef.current = setTimeout(() => {
			onSearchChange(value || '')
		}, 300)
	}

	// "Clear all" only earns its place once more than one pill is active —
	// with a single pill its own × already does the job (mockup 920).
	const showClearAll = !!onClearAllFilters && filterPills.length > 1

	return (
		<div className="flex min-h-7 flex-none flex-wrap items-center gap-x-1.5 gap-y-2">
			{axisChips.length > 0 && onAxisValueChange && (
				<FilterTabs
					variant="pill"
					tabs={axisChips}
					value={axisValue}
					onChange={onAxisValueChange}
					aria-label={axisLabel}
				/>
			)}

			{filterPills.length > 0 && (
				<Separator orientation="vertical" className="mx-1 h-[18px] shrink-0" />
			)}

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
					className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
					onClick={onClearAllFilters}
				>
					Clear all
				</Button>
			)}

			{/* Everything after this point is right-aligned (mockup 921). */}
			<div className="ml-auto flex min-w-0 basis-full items-center justify-end gap-2 sm:basis-auto">
				<div className="relative min-w-0 max-w-[14rem] flex-1">
					<Search
						size={14}
						className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						value={localSearch}
						onChange={(e) => handleSearchChange(e.target.value)}
						placeholder="Search..."
						className="h-8 pl-8 text-sm"
					/>
				</div>

				<DisplayPanel
					view={view}
					onViewChange={onViewChange}
					boardSupported={boardSupported}
					columns={columns}
					columnVisibility={columnVisibility}
					onColumnVisibilityChange={onColumnVisibilityChange}
					filterBy={filterBy}
					onFilterByChange={onFilterByChange}
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
				/>

				{/* Import is occasional; New lives only in the global header. */}
				<Button variant="ghost" size="sm" className="gap-1.5" onClick={onImportClick}>
					<Upload size={14} />
					Import
				</Button>
			</div>
		</div>
	)
}
