import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { useActor, useActors } from '@/hooks/use-actors'
import { useFiles } from '@/hooks/use-files'
import type { ActorListItem, EventResponse, SessionResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Link, useNavigate } from '@tanstack/react-router'
import { Reply } from 'lucide-react'
import { useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
import { AgentOutput } from '../shared/agent-output'
import { AttachedFileCard } from '../shared/attached-file-card'
import { RelativeTime } from '../shared/relative-time'
import { CommentInput } from './comment-input'
import { DecisionChips, hasDecisionChips } from './decision-chips'
import { MentionSessionCard } from './mention-session-card'

const COMMENT_DISALLOWED_ELEMENTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

interface ActivityCommentProps {
	event: EventResponse
	replies?: EventResponse[]
	workspaceId: string
	objectId: string
	mentionSessions?: SessionResponse[]
	dividerBeforeReplyId?: number
	divider?: React.ReactNode
	isUnread?: boolean
}

interface CommentRowProps {
	event: EventResponse
	actors: ActorListItem[]
	workspaceId: string
	onReply?: () => void
	isUnread?: boolean
	isDecisionPoint?: boolean
}

function CommentRow({
	event,
	actors,
	workspaceId,
	onReply,
	isUnread,
	isDecisionPoint,
}: CommentRowProps) {
	const { data: actor } = useActor(event.actorId)
	const content = (event.data?.content as string) ?? ''
	const attachmentFileIds = (event.data?.attachmentFileIds as string[] | undefined) ?? []
	const { data: workspaceFiles } = useFiles(workspaceId)
	const [humanDialogActorId, setHumanDialogActorId] = useState<string | null>(null)
	const navigate = useNavigate()

	const handleMentionClick = (mentioned: ActorListItem) => {
		if (mentioned.type === 'agent') {
			navigate({
				to: '/$workspaceId/agents/$agentId',
				params: { workspaceId, agentId: mentioned.id },
			})
		} else {
			setHumanDialogActorId(mentioned.id)
		}
	}

	const isAgent = actor?.type === 'agent'

	const avatarEl = actor ? (
		isAgent ? (
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: actor.id }}
				aria-hidden="true"
				tabIndex={-1}
			>
				<ActorAvatar name={actor.name} type={actor.type} size="sm" />
			</Link>
		) : (
			<ActorAvatar
				name={actor.name}
				type={actor.type}
				size="sm"
				onClick={() => setHumanDialogActorId(actor.id)}
			/>
		)
	) : null

	const nameEl = !actor ? (
		<span className="text-sm font-medium text-foreground">Unknown</span>
	) : isAgent ? (
		<Link
			to="/$workspaceId/agents/$agentId"
			params={{ workspaceId, agentId: actor.id }}
			className={cn('text-sm font-medium text-primary hover:underline transition-colors')}
		>
			{actor.name}
		</Link>
	) : (
		<button
			type="button"
			onClick={() => setHumanDialogActorId(actor.id)}
			className={cn(
				'text-sm font-medium text-foreground cursor-pointer hover:underline transition-colors',
			)}
		>
			{actor.name}
		</button>
	)

	return (
		<>
			<div
				className={cn(
					'relative flex items-start gap-2 py-1 px-1 -mx-1 rounded-md hover:bg-secondary/50 transition-colors',
					isDecisionPoint && 'pl-3',
				)}
			>
				{isDecisionPoint && (
					<span
						aria-hidden
						className="absolute left-1 top-2 bottom-2 w-0.5 rounded-full bg-primary"
					/>
				)}
				<div className="relative shrink-0">
					{avatarEl}
					{isUnread && (
						<span
							aria-label="Unread"
							className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary ring-1 ring-background"
						/>
					)}
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-baseline gap-1.5 flex-wrap">
						{nameEl}
						<RelativeTime date={event.createdAt} className="text-muted-foreground text-xs" />
						{isDecisionPoint && (
							<span className="text-[10px] font-medium leading-none px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground">
								Needs you
							</span>
						)}
					</div>
					<AgentOutput
						content={content}
						disallowedElements={COMMENT_DISALLOWED_ELEMENTS}
						mentionActors={actors}
						onMentionClick={handleMentionClick}
						size="sm"
						className="mt-1"
					/>
					{attachmentFileIds.length > 0 && (
						<ul className="mt-1.5 space-y-1">
							{attachmentFileIds.map((fileId) => {
								const file = workspaceFiles?.find((f) => f.id === fileId)
								if (!file) return null
								return (
									<li key={fileId}>
										<AttachedFileCard workspaceId={workspaceId} file={file} />
									</li>
								)
							})}
						</ul>
					)}
				</div>
				{onReply && (
					<button
						type="button"
						onClick={onReply}
						aria-label="Reply"
						/* Always visible on touch (no hover capability); fades behind hover/focus on mouse devices. */
						className="opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground self-end shrink-0 p-1 -m-1"
					>
						<Reply size={14} />
					</button>
				)}
			</div>
			{humanDialogActorId && (
				<HumanDetailDialog
					actorId={humanDialogActorId}
					workspaceId={workspaceId}
					open={true}
					onOpenChange={(open) => {
						if (!open) setHumanDialogActorId(null)
					}}
				/>
			)}
		</>
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
	isUnread,
}: ActivityCommentProps) {
	const { data: actors } = useActors(workspaceId)
	const [showReplyInput, setShowReplyInput] = useState(false)
	const openReplyInput = () => setShowReplyInput(true)
	const hasReplies = replies.length > 0
	const actorList = actors ?? []
	const isDecisionPoint = hasDecisionChips(event)
	const currentActorId = getStoredActor()?.id
	const alreadyReplied = !!currentActorId && replies.some((r) => r.actorId === currentActorId)

	return (
		<div id={`comment-${event.id}`} className="group">
			<CommentRow
				event={event}
				actors={actorList}
				workspaceId={workspaceId}
				onReply={hasReplies ? undefined : openReplyInput}
				isUnread={isUnread}
				isDecisionPoint={isDecisionPoint}
			/>

			{isDecisionPoint && !alreadyReplied && (
				<div className="ml-7 mt-1.5">
					<DecisionChips event={event} objectId={objectId} workspaceId={workspaceId} />
				</div>
			)}

			{mentionSessions.length > 0 && (
				<div className="ml-7 mt-1 space-y-1">
					{mentionSessions.map((session) => (
						<MentionSessionCard key={session.id} session={session} workspaceId={workspaceId} />
					))}
				</div>
			)}

			{hasReplies && (
				<div className="ml-7 space-y-1.5">
					{replies.map((reply, idx) => (
						<div key={reply.id}>
							{divider && dividerBeforeReplyId === reply.id && divider}
							<CommentRow
								event={reply}
								actors={actorList}
								workspaceId={workspaceId}
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
