import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
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
	// One lead avatar (mockup 527): the first participant who isn't the viewer,
	// falling back to the first participant in a solo thread.
	const self = getStoredActor()
	const lead =
		conversation.participants.find((p) => p.actorId !== self?.id) ?? conversation.participants[0]
	const isUnread = conversation.unread_count > 0

	return (
		<Link
			to="/$workspaceId/chats/$conversationId"
			params={{ workspaceId, conversationId: conversation.id }}
			activeProps={{ className: 'bg-accent' }}
			className="flex items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-accent"
		>
			{lead ? (
				<ActorAvatar
					id={lead.actorId}
					name={lead.actorName}
					type={lead.actorType}
					size="md"
					className="mt-px shrink-0 rounded-lg"
				/>
			) : null}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					{isUnread ? (
						<span
							aria-label={`${conversation.unread_count} unread`}
							className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
						/>
					) : null}
					<span
						className={cn(
							'min-w-0 flex-1 truncate text-[12.5px] tracking-[-0.01em] text-foreground',
							isUnread ? 'font-bold' : 'font-medium',
						)}
					>
						{conversation.title}
					</span>
					{conversation.pinned ? (
						<Pin size={10} className="shrink-0 text-muted-foreground" aria-label="Pinned" />
					) : null}
					<RelativeTime
						date={conversation.lastMessageAt ?? conversation.createdAt}
						className="shrink-0 text-[10px] text-muted-foreground"
					/>
				</div>
				<span className="mt-0.5 line-clamp-2 text-[11.5px] leading-[1.4] text-muted-foreground">
					{conversation.snippet ?? 'No messages yet'}
				</span>
			</div>
		</Link>
	)
}
