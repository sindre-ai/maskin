import { FilterTabs } from '@/components/shared/filter-tabs'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUpDown, LayoutGrid, List, Newspaper, Plus, SlidersHorizontal } from 'lucide-react'

export type FeedMode = 'cards' | 'list'
export type FeedSort = 'latest' | 'priority'

const SORT_LABEL: Record<FeedSort, string> = {
	latest: 'Latest activity',
	priority: 'Priority',
}

const SORT_OPTIONS: readonly FeedSort[] = ['priority', 'latest']

interface ForYouHeaderProps {
	unreadCount: number
	typeFilter: string | undefined
	onTypeFilterChange: (value: string | undefined) => void
	typeCounts: Map<string, number>
	mentionCount: number
	mode: FeedMode
	onModeChange: (mode: FeedMode) => void
	sort: FeedSort
	onSortChange: (sort: FeedSort) => void
	onStartConversation: () => void
	onCreateObject: (type: 'bet' | 'insight' | 'task') => void
}

// Redesigned For You header (parent bet 37865542). Title row with count +
// Brief/+New actions; a sub-row with a dynamic type-filter chip bar (All,
// Mentions, then one chip per object type present in the unread queue) and a
// single "Display" popover holding Cards/List + Sort — replaces the previous
// separate Cards/List tabs + sort dropdown + All/Mentions tabs. Below sm the
// title labels collapse to icons; every icon-only control carries an explicit
// `aria-label`.
export function ForYouHeader({
	unreadCount,
	typeFilter,
	onTypeFilterChange,
	typeCounts,
	mentionCount,
	mode,
	onModeChange,
	sort,
	onSortChange,
	onStartConversation,
	onCreateObject,
}: ForYouHeaderProps) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()

	const filterTabs = [
		{ label: 'All', value: undefined as string | undefined, count: unreadCount },
		{ label: 'Mentions', value: 'mentions', count: mentionCount },
		...Array.from(typeCounts.entries()).map(([type, count]) => ({
			label: type.charAt(0).toUpperCase() + type.slice(1),
			value: type,
			count,
		})),
	]

	return (
		<header className="mb-2 flex flex-col gap-3">
			<div className="flex items-center gap-3">
				<h1 className="flex items-baseline gap-2 text-2xl font-semibold leading-tight tracking-tight">
					For You
					<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
						{unreadCount} unread
					</span>
				</h1>
				<div className="ml-auto flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						aria-label="Today's brief"
						onClick={() => navigate({ to: '/$workspaceId/briefing', params: { workspaceId } })}
						className="h-8 gap-1.5 px-2 sm:px-3"
					>
						<Newspaper size={14} aria-hidden />
						<span className="hidden sm:inline">Today's brief</span>
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="sm" aria-label="New" className="h-8 gap-1.5 px-2 sm:px-3">
								<Plus size={14} aria-hidden />
								<span className="hidden sm:inline">New</span>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-[200px]">
							<DropdownMenuItem onSelect={onStartConversation}>Start conversation</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => onCreateObject('bet')}>New bet</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => onCreateObject('insight')}>
								New insight
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => onCreateObject('task')}>New task</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1 overflow-x-auto">
					<FilterTabs
						aria-label="Filter unread feed"
						value={typeFilter}
						onChange={onTypeFilterChange}
						tabs={filterTabs}
					/>
				</div>

				<ResponsivePopover>
					<ResponsivePopoverTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							aria-label="Display options"
							className="h-8 shrink-0 gap-1.5 px-2 sm:px-3"
						>
							<SlidersHorizontal size={14} aria-hidden />
							<span className="hidden sm:inline">Display</span>
						</Button>
					</ResponsivePopoverTrigger>
					<ResponsivePopoverContent align="end" accessibleTitle="Display options" className="w-64">
						<div className="space-y-3">
							<Tabs
								value={mode}
								onValueChange={(v) => onModeChange(v as FeedMode)}
								aria-label="Display mode"
							>
								<TabsList className="h-8 w-full gap-1 p-1">
									<TabsTrigger
										value="cards"
										aria-label="Cards"
										className="h-6 flex-1 gap-1.5 px-2 text-xs"
									>
										<LayoutGrid size={14} aria-hidden />
										Cards
									</TabsTrigger>
									<TabsTrigger
										value="list"
										aria-label="List"
										className="h-6 flex-1 gap-1.5 px-2 text-xs"
									>
										<List size={14} aria-hidden />
										List
									</TabsTrigger>
								</TabsList>
							</Tabs>

							<Separator />

							<div>
								<p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
									<ArrowUpDown size={12} aria-hidden />
									Sort by
								</p>
								<RadioGroup value={sort} onValueChange={(v) => onSortChange(v as FeedSort)}>
									{SORT_OPTIONS.map((value) => (
										<label
											key={value}
											htmlFor={`sort-${value}`}
											className="flex items-center gap-2 text-sm"
										>
											<RadioGroupItem value={value} id={`sort-${value}`} />
											{SORT_LABEL[value]}
										</label>
									))}
								</RadioGroup>
							</div>
						</div>
					</ResponsivePopoverContent>
				</ResponsivePopover>
			</div>
		</header>
	)
}
