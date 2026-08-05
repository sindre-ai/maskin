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
import {
	ArrowUpDown,
	CheckCheck,
	LayoutGrid,
	List,
	Newspaper,
	Plus,
	SlidersHorizontal,
} from 'lucide-react'

export type FeedMode = 'cards' | 'list'
export type FeedSort = 'latest' | 'priority'

const SORT_LABEL: Record<FeedSort, string> = {
	latest: 'Latest activity',
	priority: 'Priority',
}

const SORT_OPTIONS: readonly FeedSort[] = ['priority', 'latest']

interface ForYouHeaderIdentityProps {
	unreadCount: number
}

// Compact "For You" title + unread badge projected into the global header's
// sticky-identity slot (same slot/style bet-detail pages use via
// StickyBetIdentity) — this replaces the breadcrumb on the For You route so
// the title only appears once.
export function ForYouHeaderIdentity({ unreadCount }: ForYouHeaderIdentityProps) {
	return (
		<div className="flex min-w-0 items-baseline gap-2" data-testid="foryou-header-identity">
			<span className="truncate text-base font-semibold text-foreground">For You</span>
			<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
				{unreadCount} unread
			</span>
		</div>
	)
}

interface ForYouHeaderActionsProps {
	onStartConversation: () => void
	onCreateObject: (type: 'bet' | 'insight' | 'task') => void
	// Optional so the button only renders where a caller wires it up — kept out
	// of test render helpers that don't pass it.
	onMarkAllRead?: () => void
	markAllReadDisabled?: boolean
}

// "Mark all read" + "Today's brief" + "New" projected into the global header's
// actions slot — replaces the generic Create/Chat icon buttons on the For You route.
export function ForYouHeaderActions({
	onStartConversation,
	onCreateObject,
	onMarkAllRead,
	markAllReadDisabled,
}: ForYouHeaderActionsProps) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()

	return (
		<div className="flex items-center gap-2">
			{onMarkAllRead && (
				<Button
					variant="outline"
					size="sm"
					aria-label="Mark all as read"
					onClick={onMarkAllRead}
					disabled={markAllReadDisabled}
					className="h-8 gap-1.5 px-2 sm:px-3"
				>
					<CheckCheck size={14} aria-hidden />
					<span className="hidden sm:inline">Mark all read</span>
				</Button>
			)}
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
	)
}

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
}

// Redesigned For You header (parent bet 37865542). Dynamic type-filter chip
// bar (All, Mentions, then one chip per object type present in the unread
// queue) and a single "Display" popover holding Cards/List + Sort — replaces
// the previous separate Cards/List tabs + sort dropdown + All/Mentions tabs.
// The title and Brief/New actions live in the global header instead (see
// ForYouHeaderIdentity/ForYouHeaderActions) so they aren't duplicated here.
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
}: ForYouHeaderProps) {
	const filterTabs = [
		{ label: 'All', value: undefined as string | undefined, count: unreadCount },
		...(mentionCount > 0 ? [{ label: 'Mentions', value: 'mentions', count: mentionCount }] : []),
		...Array.from(typeCounts.entries())
			.filter(([, count]) => count > 0)
			.map(([type, count]) => ({
				label: type.charAt(0).toUpperCase() + type.slice(1),
				value: type,
				count,
			})),
	]

	return (
		<header className="mb-2">
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
