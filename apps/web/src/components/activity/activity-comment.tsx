import { useActor } from '@/hooks/use-actors'
import type { EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Reply } from 'lucide-react'
import { useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
import { RelativeTime } from '../shared/relative-time'
import { CommentInput } from './comment-input'

interface ActivityCommentProps {
	event: EventResponse
	replies?: EventResponse[]
	workspaceId: string
	objectId: string
}

/** Renders @mentions as styled chips in comment text */
function renderCommentContent(content: string) {
	const parts = content.split(/(@\w[\w\s]*?\b)/g)
	return parts.map((part) => {
		if (part.startsWith('@')) {
			return (
				<span
					key={part}
					className="inline-flex items-center rounded px-1 py-0.5 text-xs font-medium bg-primary/10 text-primary"
				>
					{part}
				</span>
			)
		}
		return part
	})
}

interface CommentRowProps {
	event: EventResponse
	onReply: () => void
}

function CommentRow({ event, onReply }: CommentRowProps) {
	const { data: actor } = useActor(event.actorId)
	const content = (event.data?.content as string) ?? ''

	return (
		<div className="group flex items-start gap-2 py-1">
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
				<p className="text-sm mt-0.5 whitespace-pre-wrap">{renderCommentContent(content)}</p>
			</div>
			<button
				type="button"
				onClick={onReply}
				aria-label="Reply"
				className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0 p-1 -m-1"
			>
				<Reply size={14} />
			</button>
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

	return (
		<div>
			<CommentRow event={event} onReply={() => setShowReplyInput(true)} />

			{replies.length > 0 && (
				<div className="ml-7 space-y-0.5">
					{replies.map((reply) => (
						<CommentRow key={reply.id} event={reply} onReply={() => setShowReplyInput(true)} />
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
