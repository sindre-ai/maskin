/**
 * Pre-v2 conversation list row, restored verbatim from before the v2 Chats
 * redesign. Rendered when the `new-design` flag is OFF; the v2 replacement
 * lives one directory up. This whole directory dies with that flag
 * (`.claude/rules/feature-flags.md`).
 */
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { UnreadBadge } from '@/components/shared/unread-badge'
import type { ConversationListItemResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { Pin } from 'lucide-react'

interface ConversationListRowProps {
	workspaceId: string
	conversation: ConversationListItemResponse
}

export function ConversationListRow({ workspaceId, conversation }: ConversationListRowProps) {
	// The current user already knows they're in the chat — only show the others.
	// A solo conversation falls back to the full list so the row keeps an avatar.
	const currentActorId = getStoredActor()?.id
	const others = conversation.participants.filter((p) => p.actorId !== currentActorId)
	const visibleParticipants = (others.length > 0 ? others : conversation.participants).slice(0, 3)

	return (
		<Link
			to="/$workspaceId/chats/$conversationId"
			params={{ workspaceId, conversationId: conversation.id }}
			activeProps={{ className: 'bg-bg-hover' }}
			className="flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-bg-hover"
		>
			<div className="mt-0.5 flex shrink-0 items-center -space-x-1.5">
				{visibleParticipants.map((p) => (
					<ActorAvatar
						key={p.actorId}
						id={p.actorId}
						name={p.actorName}
						type={p.actorType}
						size="sm"
						className="ring-2 ring-background"
					/>
				))}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span
						className={cn(
							'min-w-0 flex-1 truncate text-sm',
							conversation.unread_count > 0 ? 'font-semibold text-foreground' : 'text-foreground',
						)}
					>
						{conversation.title}
					</span>
					{conversation.pinned ? (
						<Pin size={11} className="shrink-0 text-muted-foreground" aria-label="Pinned" />
					) : null}
					<RelativeTime
						date={conversation.lastMessageAt ?? conversation.createdAt}
						className="shrink-0 text-[11px] text-muted-foreground"
					/>
				</div>
				<div className="mt-0.5 flex items-center gap-1.5">
					<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
						{conversation.snippet ?? 'No messages yet'}
					</span>
					<UnreadBadge count={conversation.unread_count} className="shrink-0" />
				</div>
			</div>
		</Link>
	)
}
