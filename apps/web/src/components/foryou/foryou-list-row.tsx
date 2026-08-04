import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

interface ForYouListRowProps {
	workspaceId: string
	item: UnreadItem
	onActivate: () => void
}

// Single-line row used when the header toggle switches the feed to List
// mode. Deliberately carries no chips or buttons — the redesign's list mode
// is a scan surface, not an action surface. Click drops the user into the
// object detail where the full card actions live.
export function ForYouListRow({ workspaceId, item, onActivate }: ForYouListRowProps) {
	const isMentioned = item.mentioning_unread_count > 0
	const isUnread = item.unread_count > 0
	const title = item.object?.title || 'Untitled'
	const type = item.object?.type

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: item.entity_id }}
			onClick={onActivate}
			className="group flex items-center gap-3 border-b border-border px-3 py-2 text-sm hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none"
			aria-label={title}
		>
			<span
				aria-hidden
				className={cn(
					'h-2 w-2 shrink-0 rounded-full',
					isMentioned ? 'bg-warning' : isUnread ? 'bg-primary' : 'bg-transparent',
				)}
			/>
			<span
				className={cn(
					'min-w-0 flex-1 truncate',
					isUnread ? 'font-medium text-foreground' : 'text-muted-foreground',
				)}
			>
				{title}
			</span>
			<span className="hidden shrink-0 items-center gap-1 sm:flex">
				{type ? <TypeBadge type={type} /> : null}
				{item.object?.status ? <StatusBadge status={item.object.status} /> : null}
			</span>
		</Link>
	)
}
