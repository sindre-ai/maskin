import { useActor, useActors } from '@/hooks/use-actors'
import type { ActorListItem, EventResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Reply } from 'lucide-react'
import { useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
import { MarkdownContent } from '../shared/markdown-content'
import { RelativeTime } from '../shared/relative-time'
import { CommentInput } from './comment-input'
import { MentionSessionCard } from './mention-session-card'

const COMMENT_DISALLOWED_ELEMENTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

const COMMENT_PROSE_OVERRIDES = cn(
	'mt-0.5',
	'[&_p]:!text-foreground [&_li]:!text-foreground [&_blockquote]:!text-foreground',
	'[&_p]:!my-0 [&_ul]:!my-1 [&_ol]:!my-1 [&_blockquote]:!my-1 [&_pre]:!my-1',
	'[&_p]:!leading-snug [&_li]:!leading-snug',
)

interface ActivityCommentProps {
	event: EventResponse
	replies?: EventResponse[]
	workspaceId: string
	objectId: string
	mentionSessions?: SessionResponse[]
	dividerBeforeReplyId?: number
	divider?: React.ReactNode
}

interface CommentRowProps {
	event: EventResponse
	actors: ActorListItem[]
	onReply?: () => void
}

function CommentRow({ event, actors, onReply }: CommentRowProps) {
	const { data: actor } = useActor(event.actorId)
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
				<MarkdownContent
					content={content}
					disallowedElements={COMMENT_DISALLOWED_ELEMENTS}
					mentionActors={actors}
					size="sm"
					className={COMMENT_PROSE_OVERRIDES}
				/>
			</div>
			{onReply && (
				<button
					type="button"
					onClick={onReply}
					aria-label="Reply"
					className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground self-end shrink-0 p-1 -m-1"
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
	mentionSessions = [],
	dividerBeforeReplyId,
	divider,
}: ActivityCommentProps) {
	const { data: actors } = useActors(workspaceId)
	const [showReplyInput, setShowReplyInput] = useState(false)
	const openReplyInput = () => setShowReplyInput(true)
	const hasReplies = replies.length > 0
	const actorList = actors ?? []

	return (
		<div className="group">
			<CommentRow
				event={event}
				actors={actorList}
				onReply={hasReplies ? undefined : openReplyInput}
			/>

			{mentionSessions.length > 0 && (
				<div className="ml-7 mt-1 space-y-1">
					{mentionSessions.map((session) => (
						<MentionSessionCard key={session.id} session={session} workspaceId={workspaceId} />
					))}
				</div>
			)}

			{hasReplies && (
				<div className="ml-7 space-y-0.5">
					{replies.map((reply, idx) => (
						<div key={reply.id}>
							{divider && dividerBeforeReplyId === reply.id && divider}
							<CommentRow
								event={reply}
								actors={actorList}
								onReply={idx === replies.length - 1 ? openReplyInput : undefined}
							/>
						</div>
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
