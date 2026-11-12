import type { ChatListView } from '@/lib/chat-list-view'
import { cn } from '@/lib/cn'

const VIEWS: Array<{ value: ChatListView; label: string }> = [
	{ value: 'agents', label: 'Agents' },
	{ value: 'recent', label: 'Recent' },
]

/**
 * The small Agents / Recent switch under the Chats title. Agents folds each agent's chats into one
 * row; Recent is the flat newest-first list, one tap away if grouping buries something.
 */
export function ChatListViewSwitch({
	value,
	onChange,
	className,
}: {
	value: ChatListView
	onChange: (next: ChatListView) => void
	className?: string
}) {
	return (
		<div
			role="tablist"
			aria-label="Chat list view"
			className={cn('flex w-fit items-center gap-0.5 rounded-full bg-secondary p-0.5', className)}
		>
			{VIEWS.map((v) => (
				<button
					key={v.value}
					type="button"
					role="tab"
					aria-selected={value === v.value}
					onClick={() => onChange(v.value)}
					className={cn(
						'rounded-full px-3 py-1 font-semibold text-[12.5px] transition-colors max-md:min-h-11',
						value === v.value
							? 'bg-background text-foreground shadow-[inset_0_0_0_1px_var(--border)]'
							: 'text-muted-foreground hover:text-foreground',
					)}
				>
					{v.label}
				</button>
			))}
		</div>
	)
}
