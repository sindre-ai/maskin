import { CHAT_PILLS, type ChatPill } from '@/lib/chat-list-v2'
import { cn } from '@/lib/cn'

/**
 * The filter pills under the list head: All, Needs you, Unread, Working, Later. Selected is ink
 * with inverted text. An inactive pill shows its count when above 0, and no count at all while the
 * list loads. Below 640px the row scrolls sideways in one line.
 */
export function ChatPills({
	value,
	onChange,
	counts,
}: {
	value: ChatPill
	onChange: (next: ChatPill) => void
	/** Null while the list is loading: the pills render at once, without numbers. */
	counts: Record<ChatPill, number> | null
}) {
	return (
		<fieldset
			aria-label="Filter chats"
			className="m-0 flex min-w-0 flex-none gap-2 overflow-x-auto border-0 px-4 pb-3 [scrollbar-width:none] lg:pl-7 max-sm:flex-nowrap [&::-webkit-scrollbar]:hidden"
		>
			{CHAT_PILLS.map((pill) => {
				const active = pill.value === value
				const count = counts?.[pill.value] ?? 0
				return (
					<button
						key={pill.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(pill.value)}
						className={cn(
							'relative inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-semibold touch-hit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
							active
								? 'bg-foreground text-background'
								: 'bg-secondary text-foreground hover:bg-accent',
						)}
					>
						{pill.label}
						{!active && counts && count > 0 ? (
							<span className="font-medium text-muted-foreground">{count}</span>
						) : null}
					</button>
				)
			})}
		</fieldset>
	)
}
