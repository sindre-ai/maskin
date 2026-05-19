import { useActor, useActors } from '@/hooks/use-actors'
import type { EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Reply } from 'lucide-react'
import { useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
import { MentionedText } from '../shared/mentioned-text'
import { RelativeTime } from '../shared/relative-time'
import { CommentInput } from './comment-input'

interface ActivityCommentProps {
	event: EventResponse
	replies?: EventResponse[]
	workspaceId: string
	objectId: string
}

interface CommentRowProps {
	event: EventResponse
	workspaceId: string
	onReply?: () => void
}

function CommentRow({ event, workspaceId, onReply }: CommentRowProps) {
	const { data: actor } = useActor(event.actorId)
	const { data: actors } = useActors(workspaceId)
	const content = (event.data?.content as string) ?? ''

	return (
		<div className="flex items-start gap-2 py-1">
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
			<div className="flex-1 min-w-0">
				<div className="flex items-baseline gap-1.5">
					<span
						className={cn(
							'text-sm font-medium',
							actor?.type === 'agent' ? 'text-primary' : 'text-foreground',
						)}
					>
						{actor?.name ?? 'Unknown'}
					</span>
					<RelativeTime date={event.createdAt} className="text-muted-foreground text-xs" />
				</div>
				<p className="text-sm mt-0.5 whitespace-pre-wrap break-words">
					<MentionedText content={content} actors={actors ?? []} />
				</p>
			</div>
			{onReply && (
				<button
					type="button"
					onClick={onReply}
					aria-label="Reply"
					className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0 p-1 -m-1"
				>
					<Reply size={14} />
				</button>
			)}
		</div>
	)
}

export function ActivityComment({
	event,
	replies = [],
	workspaceId,
	objectId,
}: ActivityCommentProps) {
	const [showReplyInput, setShowReplyInput] = useState(false)
	const openReplyInput = () => setShowReplyInput(true)
	const hasReplies = replies.length > 0

	return (
		<div className="group">
			<CommentRow
				event={event}
				workspaceId={workspaceId}
				onReply={hasReplies ? undefined : openReplyInput}
			/>

			{hasReplies && (
				<div className="ml-7 space-y-0.5">
					{replies.map((reply, idx) => (
						<CommentRow
							key={reply.id}
							event={reply}
							workspaceId={workspaceId}
							onReply={idx === replies.length - 1 ? openReplyInput : undefined}
						/>
					))}
				</div>
			)}

			{showReplyInput && (
				<div className="ml-7 mt-2">
					<CommentInput workspaceId={workspaceId} objectId={objectId} parentEventId={event.id} />
				</div>
			)}
		</div>
	)
}
