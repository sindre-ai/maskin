import { FilterTabs } from '@/components/shared/filter-tabs'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ArrowUpDown, CheckCheck, ChevronDown, LayoutGrid, List, Newspaper } from 'lucide-react'

export type FeedMode = 'cards' | 'list'
export type FeedSort = 'latest' | 'priority' | 'oldest'

const SORT_LABEL: Record<FeedSort, string> = {
	priority: 'Most urgent',
	latest: 'Newest first',
	oldest: 'Oldest first',
}

const SORT_OPTIONS: readonly FeedSort[] = ['priority', 'latest', 'oldest']

// The chip's leading swatch uses the type's *foreground* token as a fill — the
// `-bg` tint is a pale wash built to sit under text and reads as blank at 6px.
// Written out as literals so Tailwind's class scanner sees them.
const CHIP_DOT: Record<string, string> = {
	insight: 'bg-type-insight-text',
	bet: 'bg-type-bet-text',
	task: 'bg-type-task-text',
}
const DEFAULT_CHIP_DOT = 'bg-muted-foreground'

interface ForYouHeaderActionsProps {
	// Optional so the button only renders where a caller wires it up — kept out
	// of test render helpers that don't pass it.
	onMarkAllRead?: () => void
	markAllReadDisabled?: boolean
	onOpenBrief: () => void
}

// "Brief" + "Mark all read" projected into the shared top nav's actions slot.
// The nav owns the title/subtitle and the global New menu — this component
// only contributes the two For You-specific affordances. Mark-all-read is
// *absent* rather than disabled when there's nothing unread (mockup 218's
// `cuHas` gate) so the nav row doesn't carry a dead control.
export function ForYouHeaderActions({
	onMarkAllRead,
	markAllReadDisabled,
	onOpenBrief,
}: ForYouHeaderActionsProps) {
	return (
		<div className="flex items-center gap-1">
			<Button variant="ghost" size="sm" aria-label="Today's brief" onClick={onOpenBrief}>
				<Newspaper size={14} aria-hidden />
				<span className="hidden sm:inline">Brief</span>
			</Button>
			{onMarkAllRead && !markAllReadDisabled && (
				<Button variant="ghost" size="sm" aria-label="Mark all as read" onClick={onMarkAllRead}>
					<CheckCheck size={14} aria-hidden />
					<span className="hidden sm:inline">Mark all read</span>
				</Button>
			)}
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

// The v2 filter row (mockup 283–305): per-type chips on the left, a "Display"
// popover holding Cards/List + Sort on the right, both centred on the same
// 760px column the card queue uses. The whole row disappears when there is
// nothing unread (`cuFilterShow`) — an "All (0)" chip is noise on a drained
// feed. The screen title and Brief/Mark-all-read actions live in the shared
// top nav instead (see ForYouHeaderActions).
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
	if (unreadCount === 0 && typeCounts.size === 0) return null

	const filterTabs = [
		{ label: 'All', value: undefined as string | undefined, count: unreadCount },
		...(mentionCount > 0 ? [{ label: 'Mentions', value: 'mentions', count: mentionCount }] : []),
		...Array.from(typeCounts.entries())
			.filter(([, count]) => count > 0)
			.map(([type, count]) => ({
				label: type.charAt(0).toUpperCase() + type.slice(1),
				value: type,
				count,
				dot: CHIP_DOT[type] ?? DEFAULT_CHIP_DOT,
				dotShape: 'square' as const,
			})),
	]

	return (
		<header className="mx-auto mb-2 flex w-full max-w-[760px] items-center gap-2">
			<div className="min-w-0 flex-1">
				<FilterTabs
					aria-label="Filter unread feed"
					variant="pill"
					value={typeFilter}
					onChange={onTypeFilterChange}
					tabs={filterTabs}
				/>
			</div>

			<ResponsivePopover>
				<ResponsivePopoverTrigger asChild>
					<Button variant="outline" size="sm" aria-label="Display options" className="shrink-0">
						<span className="hidden sm:inline">Display</span>
						<ChevronDown size={14} className="opacity-70" aria-hidden />
					</Button>
				</ResponsivePopoverTrigger>
				<ResponsivePopoverContent
					align="end"
					accessibleTitle="Display options"
					hideCloseButton
					className="w-64"
				>
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
							<p className="eyebrow mb-2 flex items-center gap-1.5">
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
		</header>
	)
}
