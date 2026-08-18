import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'

interface ForYouListRowProps {
	item: UnreadItem
	// Set while this row's item is the one the card queue is parked on.
	current?: boolean
	// Selecting a row jumps back to Cards pinned on this item (mockup 490) —
	// list mode is a chooser for the queue, not a shortcut past it. The card's
	// own "Open →" stays the route into object detail.
	onSelect: (item: UnreadItem) => void
	// Right-hand meta line under the title — the active sort's rank word plus
	// the item's type, e.g. "Most urgent · Bet".
	subtitle?: string
}

// List-mode row (mockup 489–498): a 12px-radius card carrying the 38px type
// tile, the title, a muted sub line and the object's status dot-word. Rendered
// as a <button> because it selects rather than navigates.
export function ForYouListRow({ item, current, onSelect, subtitle }: ForYouListRowProps) {
	const title = item.object?.title || 'Untitled'
	const type = item.object?.type
	const status = item.object?.status

	return (
		<button
			type="button"
			onClick={() => onSelect(item)}
			aria-label={title}
			aria-current={current ? 'true' : undefined}
			className={cn(
				'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
				current
					? 'border-border-strong bg-muted/50'
					: 'border-border bg-card hover:border-border-strong',
			)}
		>
			{type ? <TypeBadge type={type} variant="tile" size="lg" /> : null}
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-semibold text-foreground">{title}</span>
				{subtitle && (
					<span className="mt-0.5 block truncate text-xs text-muted-foreground">{subtitle}</span>
				)}
			</span>
			{status ? (
				<span className="shrink-0 pt-0.5">
					<StatusBadge status={status} variant="dot-word" />
				</span>
			) : null}
		</button>
	)
}
