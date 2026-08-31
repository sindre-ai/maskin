import { FilterTabs } from '@/components/shared/filter-tabs'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { typeLabel } from '@/lib/constants'
import { Check, LayoutList, ListFilter, Rows3 } from 'lucide-react'

export type FeedMode = 'cards' | 'list'
export type FeedSort = 'attention' | 'chrono'

const MODE_LABEL: Record<FeedMode, string> = { cards: 'Cards', list: 'List' }
const SORT_LABEL: Record<FeedSort, string> = {
	attention: 'By attention',
	chrono: 'Chronological',
}

// The chip's leading swatch uses the type's *foreground* token as a fill — the
// `-bg` tint is a pale wash built to sit under text and reads as blank at 6px.
// Written out as literals so Tailwind's class scanner sees them.
const CHIP_DOT: Record<string, string> = {
	insight: 'bg-type-insight-text',
	bet: 'bg-type-bet-text',
	task: 'bg-type-task-text',
}
const DEFAULT_CHIP_DOT = 'bg-muted-foreground'

export interface ForYouBulkAction {
	id: string
	label: string
	/** How many cards the action would touch. Omit for an action that is always
	 *  available (the mockup prints no count for those either). */
	count?: number
	onSelect: () => void
}

interface ForYouHeaderProps {
	unreadCount: number
	typeFilter: string | undefined
	onTypeFilterChange: (value: string | undefined) => void
	typeCounts: Map<string, number>
	mode: FeedMode
	onModeChange: (mode: FeedMode) => void
	sort: FeedSort
	onSortChange: (sort: FeedSort) => void
	filterPills: boolean
	onFilterPillsChange: (value: boolean) => void
	/** The `···` menu's rows — bulk actions the feed owns (mockup `moreOpts`). */
	bulkActions: readonly ForYouBulkAction[]
}

/**
 * The control row above the feed (Feed v4, lines 27–103): an optional filter
 * pill rail on the left, then the `···` bulk menu and the view menu pinned to
 * the right of the same 700px column the feed itself uses.
 *
 * The view menu carries everything that used to be three separate controls —
 * Cards/List, the filter-pill toggle, the per-type filter and the sort — and
 * its trigger label reads back whatever is not at its default ("List",
 * "Cards · Bets · Chronological").
 */
export function ForYouHeader({
	unreadCount,
	typeFilter,
	onTypeFilterChange,
	typeCounts,
	mode,
	onModeChange,
	sort,
	onSortChange,
	filterPills,
	onFilterPillsChange,
	bulkActions,
}: ForYouHeaderProps) {
	const typeOptions = [
		{ value: undefined as string | undefined, label: 'Everything', count: unreadCount },
		...Array.from(typeCounts.entries())
			.filter(([, count]) => count > 0)
			.map(([type, count]) => ({ value: type, label: `${typeLabel(type)}s`, count })),
	]

	const menuParts = [MODE_LABEL[mode]]
	if (typeFilter) {
		menuParts.push(typeOptions.find((option) => option.value === typeFilter)?.label ?? typeFilter)
	}
	if (sort !== 'attention') menuParts.push(SORT_LABEL[sort])

	return (
		<div className="mx-auto flex w-full max-w-[700px] items-center gap-1.5 pb-0.5">
			<div className="min-w-0 flex-1">
				{filterPills && (
					<FilterTabs
						aria-label="Filter unread feed"
						variant="pill"
						value={typeFilter}
						onChange={onTypeFilterChange}
						tabs={typeOptions.map((option) => ({
							label: option.label,
							value: option.value,
							count: option.count,
							dot: option.value ? (CHIP_DOT[option.value] ?? DEFAULT_CHIP_DOT) : undefined,
							dotShape: 'square' as const,
						}))}
					/>
				)}
			</div>

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="icon"
						aria-label="Feed actions"
						className="h-[30px] w-[30px] shrink-0 rounded-lg border-border font-bold text-muted-foreground hover:border-border-strong hover:text-foreground"
					>
						<span aria-hidden className="text-[13px] leading-none">
							···
						</span>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-[250px]">
					{bulkActions.map((action) => (
						<DropdownMenuItem
							key={action.id}
							disabled={action.count === 0}
							onSelect={action.onSelect}
							className="text-xs font-semibold"
						>
							<span className="min-w-0 flex-1">{action.label}</span>
							{action.count !== undefined && action.count > 0 && (
								<span className="shrink-0 text-[10.5px] font-medium tabular-nums text-muted-foreground">
									{action.count}
								</span>
							)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						aria-label="View options"
						className="h-[30px] shrink-0 gap-[7px] rounded-lg border-border px-3 text-[11.5px] font-semibold text-muted-foreground hover:border-border-strong hover:text-foreground"
					>
						<ListFilter size={12} aria-hidden />
						<span className="max-w-[200px] truncate">{menuParts.join(' · ')}</span>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-[264px]">
					<DropdownMenuLabel className="eyebrow px-2.5 pb-1 pt-1.5">View</DropdownMenuLabel>
					{(['list', 'cards'] as const).map((value) => (
						<MenuRow
							key={value}
							label={MODE_LABEL[value]}
							selected={mode === value}
							icon={
								value === 'list' ? (
									<Rows3 size={13} aria-hidden />
								) : (
									<LayoutList size={13} aria-hidden />
								)
							}
							onSelect={() => onModeChange(value)}
						/>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuLabel className="eyebrow px-2.5 pb-1 pt-1.5">Show</DropdownMenuLabel>
					{typeOptions.map((option) => (
						<MenuRow
							key={option.value ?? 'all'}
							label={option.label}
							count={option.count}
							selected={typeFilter === option.value}
							onSelect={() => onTypeFilterChange(option.value)}
						/>
					))}

					<DropdownMenuSeparator />
					<DropdownMenuLabel className="eyebrow px-2.5 pb-1 pt-1.5">Sort</DropdownMenuLabel>
					{(['attention', 'chrono'] as const).map((value) => (
						<MenuRow
							key={value}
							label={SORT_LABEL[value]}
							selected={sort === value}
							onSelect={() => onSortChange(value)}
						/>
					))}

					<DropdownMenuSeparator />
					<MenuRow
						label="Filter bar under the header"
						selected={filterPills}
						onSelect={() => onFilterPillsChange(!filterPills)}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}

// One row of the view menu: an optional leading glyph, the label, an optional
// dim count, and the check column that stays reserved so labels don't shift
// when the selection moves (mockup's fixed 13px check cell).
function MenuRow({
	label,
	icon,
	count,
	selected,
	onSelect,
}: {
	label: string
	icon?: React.ReactNode
	count?: number
	selected: boolean
	onSelect: () => void
}) {
	return (
		<DropdownMenuItem
			onSelect={(event) => {
				// Filter/view rows are toggles the reader often fires several times
				// in a row; keeping the menu open matches the mockup.
				event.preventDefault()
				onSelect()
			}}
			aria-checked={selected}
			className={cn('text-xs', selected ? 'font-bold text-foreground' : 'text-muted-foreground')}
		>
			{icon}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count !== undefined && (
				<span className="shrink-0 text-[10.5px] font-medium tabular-nums text-muted-foreground">
					{count}
				</span>
			)}
			<span className="flex w-3.5 shrink-0 justify-end text-foreground">
				{selected && <Check size={11} aria-hidden />}
			</span>
		</DropdownMenuItem>
	)
}
