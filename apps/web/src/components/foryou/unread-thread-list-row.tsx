import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

interface UnreadThreadListRowProps {
	workspaceId: string
	item: UnreadItem
}

export function UnreadThreadListRow({ workspaceId, item }: UnreadThreadListRowProps) {
	const objectId = item.entity_id
	const title = item.object?.title ?? 'Untitled'
	const objectType = item.object?.type
	const objectStatus = item.object?.status
	const snippet = (item.object?.content ?? '').trim()
	const isUnread = item.unread_count > 0
	const isMention = item.mentioning_unread_count > 0

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId }}
			data-testid="unread-thread-list-row"
			className={cn(
				'group flex items-center gap-3 border-t border-border bg-background px-3 py-2.5 hover:bg-secondary/40',
				// Match the Card's unread accent: 2px left border, same pl-[10px]
				// compensation so unread and read rows align at their left edge.
				isUnread && 'border-l-2 pl-[10px]',
				isUnread && !isMention && 'border-l-primary',
				isUnread && isMention && 'border-l-warning',
			)}
		>
			{objectType && <TypeBadge type={objectType} className="shrink-0" />}

			{/* Title + snippet stack — must be min-w-0 so the flex child can truncate. */}
			<div className="min-w-0 flex-1">
				<div
					className={cn(
						'truncate text-[13.5px] font-medium leading-snug',
						isUnread ? 'text-foreground' : 'text-muted-foreground',
					)}
					title={title}
				>
					{title}
				</div>
				{snippet && <div className="line-clamp-1 text-xs text-muted-foreground">{snippet}</div>}
			</div>

			{objectStatus && <StatusBadge status={objectStatus} variant="dot-word" />}
			{item.latest_activity_at && (
				<RelativeTime
					date={item.latest_activity_at}
					className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
				/>
			)}
			<ChevronRight
				size={16}
				aria-hidden
				className="shrink-0 text-muted-foreground group-hover:text-foreground"
			/>
		</Link>
	)
}
