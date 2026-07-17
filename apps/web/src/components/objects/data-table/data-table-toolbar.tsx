import type { FieldDefinition } from '@/components/objects/field-value-input'
import { type FilterTabItem, FilterTabs } from '@/components/shared/filter-tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ActorListItem } from '@/lib/api'
import type { VisibilityState } from '@tanstack/react-table'
import { Plus, Search, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ColumnInfo } from './data-table-controls'
import { DisplayPanel, type DisplayPanelView } from './display-panel'

type Tab = FilterTabItem<string | undefined>

interface DataTableToolbarProps {
	// Column visibility
	columns: ColumnInfo[]
	columnVisibility: VisibilityState
	onColumnVisibilityChange: (columnId: string, visible: boolean) => void
	// Tabs
	tabs: Tab[]
	typeFilter?: string
	onTypeFilterChange: (value: string | undefined) => void
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
	// View switcher
	view?: DisplayPanelView
	onViewChange?: (view: DisplayPanelView) => void
	boardSupported?: boolean
	// Import
	onImportClick: () => void
	// New — opens the shared create picker
	onNewClick: () => void
}

export function DataTableToolbar({
	columns,
	columnVisibility,
	onColumnVisibilityChange,
	tabs,
	typeFilter,
	onTypeFilterChange,
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
	view,
	onViewChange,
	boardSupported,
	onImportClick,
	onNewClick,
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

	return (
		<div className="flex items-center gap-2 md:gap-3 mb-4 flex-wrap">
			{/* Type tabs */}
			<FilterTabs
				tabs={tabs}
				value={typeFilter}
				onChange={onTypeFilterChange}
				aria-label="Type filter"
			/>

			{/* Search */}
			<div className="relative flex-1 min-w-0 max-w-full sm:max-w-xs">
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

			{/* Display panel */}
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
			/>

			{/* Actions — Import is occasional, New is primary. Ordered per the
			 * 2026-05-30 button hierarchy call. `basis-full` below xl keeps the
			 * action cluster on its own predictable row when there isn't enough
			 * inline room (iPad landscape included); `xl:basis-auto` restores
			 * the single-row layout on wider viewports. */}
			<div className="ml-auto flex basis-full items-center justify-end gap-2 xl:basis-auto">
				<Button variant="ghost" size="sm" className="gap-1.5" onClick={onImportClick}>
					<Upload size={14} />
					Import
				</Button>
				<Button size="sm" className="gap-1.5" onClick={onNewClick}>
					<Plus size={14} />
					New
				</Button>
			</div>
		</div>
	)
}
