import { FilterTabs } from '@/components/shared/filter-tabs'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { forYouTypeOptions } from './foryou-display'

export type { FeedMode } from './foryou-display'

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
	/** Draws the row in the danger colour with a rule above it (the prototype's Dismiss all). */
	destructive?: boolean
	onSelect: () => void
}

interface ForYouHeaderProps {
	unreadCount: number
	typeFilter: string | undefined
	onTypeFilterChange: (value: string | undefined) => void
	typeCounts: Map<string, number>
	filterPills: boolean
	/** The `···` menu's rows — bulk actions the feed owns (mockup `moreOpts`). */
	bulkActions: readonly ForYouBulkAction[]
	/** The feed draws the menu itself, on its first section heading (v11). */
	hideMenu?: boolean
}

/**
 * The control row above the feed: an optional filter pill rail on the left and
 * the `···` bulk menu pinned to the right of the same column the feed uses.
 * View, Show and the filter-bar toggle live in the title row's Display menu
 * (`ForYouDisplay`).
 */
export function ForYouHeader({
	unreadCount,
	typeFilter,
	onTypeFilterChange,
	typeCounts,
	filterPills,
	bulkActions,
	hideMenu = false,
}: ForYouHeaderProps) {
	const typeOptions = forYouTypeOptions(unreadCount, typeCounts)

	// Nothing to draw: no pill rail and the menu lives on the first section heading.
	if (hideMenu && !filterPills) return null

	return (
		<div className="flex w-full max-w-280 items-center gap-1.5 pb-0.5">
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

			{!hideMenu && <ForYouBulkMenu bulkActions={bulkActions} />}
		</div>
	)
}

/** The `···` bulk menu — in v11 it sits at the right of the first section heading. */
export function ForYouBulkMenu({
	bulkActions,
}: {
	bulkActions: readonly ForYouBulkAction[]
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Feed actions"
					className="h-[30px] w-[30px] shrink-0 rounded-lg font-bold text-muted-foreground hover:text-foreground"
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
						className={cn(
							'text-xs font-semibold',
							action.destructive && 'mt-1 border-t border-border text-error focus:text-error',
						)}
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
	)
}
