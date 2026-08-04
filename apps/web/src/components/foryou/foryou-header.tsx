import { FilterTabs } from '@/components/shared/filter-tabs'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/cn'
import { ArrowUpDown, LayoutGrid, List, Newspaper, Plus } from 'lucide-react'

export type FeedFilter = 'all' | 'mentions'
export type FeedMode = 'cards' | 'list'
export type FeedSort = 'latest' | 'priority'

const SORT_LABEL: Record<FeedSort, string> = {
	latest: 'Latest activity',
	priority: 'Priority',
}

interface ForYouHeaderProps {
	unreadCount: number
	filter: FeedFilter
	onFilterChange: (value: FeedFilter) => void
	allCount: number
	mentionCount: number
	mode: FeedMode
	onModeChange: (mode: FeedMode) => void
	sort: FeedSort
	onSortChange: (sort: FeedSort) => void
	briefOpen: boolean
	onBriefToggle: () => void
	onStartConversation: () => void
	onCreateObject: (type: 'bet' | 'insight' | 'task') => void
}

// Redesigned For You header (parent bet 37865542). Layout matches the
// prototype: title row with count + Brief/+New actions; a sub-row with
// Cards/List toggle + sort + filter tabs. Below sm the labels collapse to
// icons; every icon-only control carries an explicit `aria-label` so the
// getByRole assertions T5's regression spec runs at 375 still hit.
export function ForYouHeader({
	unreadCount,
	filter,
	onFilterChange,
	allCount,
	mentionCount,
	mode,
	onModeChange,
	sort,
	onSortChange,
	briefOpen,
	onBriefToggle,
	onStartConversation,
	onCreateObject,
}: ForYouHeaderProps) {
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
						aria-pressed={briefOpen}
						aria-label="Today's brief"
						onClick={onBriefToggle}
						className={cn('h-8 gap-1.5 px-2 sm:px-3', briefOpen && 'bg-muted text-foreground')}
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

			<div className="flex flex-wrap items-center gap-2">
				<Tabs
					value={mode}
					onValueChange={(v) => onModeChange(v as FeedMode)}
					aria-label="Display mode"
				>
					<TabsList className="h-8 gap-1 p-1">
						<TabsTrigger value="cards" aria-label="Cards" className="h-6 gap-1.5 px-2 text-xs">
							<LayoutGrid size={14} aria-hidden />
							<span className="hidden sm:inline">Cards</span>
						</TabsTrigger>
						<TabsTrigger value="list" aria-label="List" className="h-6 gap-1.5 px-2 text-xs">
							<List size={14} aria-hidden />
							<span className="hidden sm:inline">List</span>
						</TabsTrigger>
					</TabsList>
				</Tabs>

				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							aria-label={`Sort by ${SORT_LABEL[sort]}`}
							className="h-8 gap-1.5 px-2 sm:px-3"
						>
							<ArrowUpDown size={14} aria-hidden />
							<span className="hidden sm:inline">Sort: </span>
							<span>{SORT_LABEL[sort]}</span>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSortChange(v as FeedSort)}>
							<DropdownMenuRadioItem value="latest">{SORT_LABEL.latest}</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="priority">{SORT_LABEL.priority}</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>

				<div className="ml-auto">
					<FilterTabs
						aria-label="Filter unread feed"
						value={filter}
						onChange={onFilterChange}
						tabs={[
							{ label: 'All', value: 'all', count: allCount },
							{ label: 'Mentions', value: 'mentions', count: mentionCount },
						]}
					/>
				</div>
			</div>
		</header>
	)
}
