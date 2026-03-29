import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import type { VisibilityState } from '@tanstack/react-table'
import { Search, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type ColumnInfo, DataTableControls } from './data-table-controls'

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
	// Controls props
	statusFilter?: string
	onStatusFilterChange: (value: string | undefined) => void
	allStatuses: string[]
	ownerFilter?: string
	onOwnerFilterChange: (value: string | undefined) => void
	actors?: Array<{ id: string; name: string }>
	sort: string
	onSortChange: (value: string) => void
	order: 'asc' | 'desc'
	onOrderChange: (value: 'asc' | 'desc') => void
	groupBy?: string
	onGroupByChange: (value: string | undefined) => void
	// Import
	onImportClick: () => void
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

	return (
		<div className="flex items-center gap-3 mb-4 flex-wrap">
			{/* Type tabs */}
			<div className="flex gap-1">
				{tabs.map((tab) => (
					<button
						key={tab.label}
						type="button"
						className={cn(
							'rounded px-3 py-1 text-sm transition-colors',
							typeFilter === tab.value
								? 'bg-muted text-foreground font-medium'
								: 'text-muted-foreground hover:text-foreground',
						)}
						onClick={() => onTypeFilterChange(tab.value)}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Search */}
			<div className="relative flex-1 max-w-xs">
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

			{/* Controls popover */}
			<DataTableControls
				columns={columns}
				columnVisibility={columnVisibility}
				onColumnVisibilityChange={onColumnVisibilityChange}
				statusFilter={statusFilter}
				onStatusFilterChange={onStatusFilterChange}
				allStatuses={allStatuses}
				ownerFilter={ownerFilter}
				onOwnerFilterChange={onOwnerFilterChange}
				actors={actors}
				sort={sort}
				onSortChange={onSortChange}
				order={order}
				onOrderChange={onOrderChange}
				groupBy={groupBy}
				onGroupByChange={onGroupByChange}
				showGroupByType={!typeFilter}
			/>

			{/* Import */}
			<Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={onImportClick}>
				<Upload size={14} />
				Import
			</Button>
		</div>
	)
}
