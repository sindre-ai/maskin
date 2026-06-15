import { FilterTabs } from '@/components/shared/filter-tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ActorListItem } from '@/lib/api'
import type { VisibilityState } from '@tanstack/react-table'
import { Plus, Search, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ColumnInfo } from './data-table-controls'
import { DisplayPanel, type DisplayPanelView } from './display-panel'

interface Tab {
	label: string
	value: string | undefined
}

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
	onResetFilters?: () => void
	sort: string
	onSortChange: (value: string) => void
	order: 'asc' | 'desc'
	onOrderChange: (value: 'asc' | 'desc') => void
	groupBy?: string
	onGroupByChange: (value: string | undefined) => void
	// View switcher
	view?: DisplayPanelView
	onViewChange?: (view: DisplayPanelView) => void
	boardSupported?: boolean
	// Import
	onImportClick: () => void
	// Create
	onNewClick?: () => void
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
	onResetFilters,
	sort,
	onSortChange,
	order,
	onOrderChange,
	groupBy,
	onGroupByChange,
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
		<div className="mb-4 flex flex-col gap-3">
			{/* Type tabs — navigation between object types. Kept on their own row so
			    they read as "which collection am I in", separate from the
			    refinement controls below. */}
			<FilterTabs
				aria-label="Object type"
				tabs={tabs}
				value={typeFilter}
				onChange={onTypeFilterChange}
			/>

			{/* Refinement + actions row: search and display options refine the
			    current collection; the action group is right-aligned with the
			    primary "New" affordance leading. */}
			<div className="flex items-center gap-2 md:gap-3 flex-wrap">
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
					onResetFilters={onResetFilters}
					sort={sort}
					onSortChange={onSortChange}
					order={order}
					onOrderChange={onOrderChange}
					groupBy={groupBy}
					onGroupByChange={onGroupByChange}
				/>

				<div className="ml-auto flex items-center gap-2">
					{/* Import is a secondary, occasional task. */}
					<Button variant="ghost" size="sm" className="gap-1.5" onClick={onImportClick}>
						<Upload size={14} />
						Import
					</Button>
					{/* Primary creation affordance lives on the page it acts on. */}
					<Button size="sm" className="gap-1.5" onClick={onNewClick}>
						<Plus size={14} />
						New
					</Button>
				</div>
			</div>
		</div>
	)
}
