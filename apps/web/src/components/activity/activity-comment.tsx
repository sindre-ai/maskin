import { useActor } from '@/hooks/use-actors'
import type { EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { MessageSquare } from 'lucide-react'
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
	// Match @Name patterns (word characters and spaces after @)
	const parts = content.split(/(@\w[\w\s]*?\b)/g)
	return parts.map((part, index) => {
		if (part.startsWith('@')) {
			return (
				<span
					key={index}
					className="inline-flex items-center rounded px-1 py-0.5 text-xs font-medium bg-primary/10 text-primary"
				>
					{part}
				</span>
			)
		}
		return part
	})
}

export function ActivityComment({
	event,
	replies = [],
	workspaceId,
	objectId,
}: ActivityCommentProps) {
	const { data: actor } = useActor(event.actorId)
	const [showReplies, setShowReplies] = useState(false)
	const [showReplyInput, setShowReplyInput] = useState(false)

	const content = (event.data?.content as string) ?? ''

	return (
		<div className="flex items-start gap-2 py-2">
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="md" className="mt-0.5" />}
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

				{/* Thread controls */}
				<div className="flex items-center gap-3 mt-1">
					{replies.length > 0 && (
						<button
							type="button"
							onClick={() => setShowReplies(!showReplies)}
							className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
						>
							<span>{showReplies ? '▾' : '▸'}</span>
							{replies.length} {replies.length === 1 ? 'reply' : 'replies'}
						</button>
					)}
					<button
						type="button"
						onClick={() => setShowReplyInput(!showReplyInput)}
						className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
					>
						<MessageSquare size={12} />
						Reply
					</button>
				</div>

				{/* Replies */}
				{showReplies && replies.length > 0 && (
					<div className="mt-2 ml-2 border-l-2 border-border pl-3 space-y-1">
						{replies.map((reply) => (
							<ReplyItem key={reply.id} event={reply} />
						))}
					</div>
				)}

				{/* Reply input */}
				{showReplyInput && (
					<div className="mt-2">
						<CommentInput
							workspaceId={workspaceId}
							objectId={objectId}
							parentEventId={event.id}
							compact
						/>
					</div>
				)}
			</div>
		</div>
	)
}

function ReplyItem({ event }: { event: EventResponse }) {
	const { data: actor } = useActor(event.actorId)
	const content = (event.data?.content as string) ?? ''

	return (
		<div className="flex items-start gap-1.5 py-1">
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" className="mt-0.5" />}
			<div className="flex-1 min-w-0">
				<div className="flex items-baseline gap-1.5">
					<span
						className={cn(
							'text-xs font-medium',
							actor?.type === 'agent' ? 'text-primary' : 'text-foreground',
						)}
					>
						{actor?.name ?? 'Unknown'}
					</span>
					<RelativeTime date={event.createdAt} className="text-muted-foreground text-[10px]" />
				</div>
				<p className="text-xs mt-0.5 whitespace-pre-wrap">{renderCommentContent(content)}</p>
			</div>
		</div>
	)
}
