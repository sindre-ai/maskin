import { CHAT_LIST_VIEWS, type ChatListViewName } from '@/lib/chat-list-sections'
import { cn } from '@/lib/cn'

/** What a tile shows while its number is still loading, and the plus when more than a page waits. */
function tileNumber(count: number | null, more: boolean): string {
	if (count === null) return '–'
	return more ? `${count}+` : String(count)
}

/**
 * The three views as tiles above the list: the number is visible before anything is opened. Each is
 * a toggle button; pressing the open one goes back to the whole list.
 */
export function ChatViewTiles({
	active,
	counts,
	onToggle,
	className,
}: {
	active: ChatListViewName | null
	counts: Record<ChatListViewName, { count: number | null; more: boolean }>
	onToggle: (view: ChatListViewName) => void
	className?: string
}) {
	return (
		<div className={cn('grid grid-cols-3 gap-2', className)}>
			{CHAT_LIST_VIEWS.map(({ value, label }) => {
				const { count, more } = counts[value]
				const pressed = active === value
				return (
					<button
						key={value}
						type="button"
						aria-pressed={pressed}
						onClick={() => onToggle(value)}
						className={cn(
							'flex min-h-[64px] flex-col items-start justify-between gap-1 rounded-xl bg-secondary px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
							pressed && 'bg-background shadow-[inset_0_0_0_1.5px_var(--foreground)]',
						)}
					>
						<span className="flex items-center gap-1.5 text-[22px] font-bold leading-none tabular-nums text-foreground">
							{value === 'running' && count !== null && count > 0 ? (
								<span
									aria-hidden
									className="size-2 animate-pulse rounded-full bg-brand motion-reduce:animate-none"
								/>
							) : null}
							<span
								className={cn(value === 'waiting' && count !== null && count > 0 && 'text-brand')}
							>
								{tileNumber(count, more)}
							</span>
						</span>
						<span className="text-[12px] font-semibold leading-tight text-muted-foreground">
							{label}
						</span>
					</button>
				)
			})}
		</div>
	)
}
