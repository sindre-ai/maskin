import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { ObjectReference } from '@/components/shared/object-reference'
import { useActor, useActors } from '@/hooks/use-actors'
import { useFiles } from '@/hooks/use-files'
import type { ActorListItem, EventResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { hasDecision, legacyChipsOf } from '@/lib/comment-decision'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, Reply } from 'lucide-react'
import { useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
import { AgentOutput } from '../shared/agent-output'
import { AttachedFileCard } from '../shared/attached-file-card'
import { RelativeTime } from '../shared/relative-time'
import { CommentDecisionBlock } from './comment-decision-block'
import { CommentInput } from './comment-input'
import { CommentTaskList, hasTaskList } from './comment-task-list'
import { MentionSessionCard } from './mention-session-card'

const COMMENT_DISALLOWED_ELEMENTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

// Long agent comments are clamped so the timeline stays readable at a glance
// (mockup 6261–6268): past 300 characters the bubble shows the first 230, cut
// at a word boundary, behind a Show more / Show less toggle.
/** Object ids the composer attached to the comment via `metadata.refs`. */
function readReferencedObjectIds(event: EventResponse): string[] {
	const metadata = event.data?.metadata as Record<string, unknown> | undefined
	const refs = metadata?.refs
	if (!Array.isArray(refs)) return []
	return refs.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

const CLAMP_OVER = 300
const CLAMP_TO = 230

function clampComment(content: string): string {
	return `${content.slice(0, CLAMP_TO).replace(/\s+\S*$/, '')}…`
}

interface ActivityCommentProps {
	event: EventResponse
	replies?: EventResponse[]
	workspaceId: string
	objectId: string
	mentionSessions?: SessionResponse[]
	dividerBeforeReplyId?: number
	divider?: React.ReactNode
	isUnread?: boolean
	// When set, the reply affordance hands the target up to the caller (the For
	// You card, which owns one shared composer and shows a "Replying to <name>"
	// banner — mockup 446–448) instead of opening this comment's own inline
	// composer.
	onReplyTo?: (event: EventResponse, authorName: string) => void
	// Root messages with replies collapse behind a "N replies · <note>" toggle
	// (mockup 369). Off by default so the object-detail feed keeps showing the
	// whole thread inline.
	collapsibleReplies?: boolean
	// Reading of the row itself — see CommentVariant.
	variant?: CommentVariant
}

/**
 * `plain` is the feed reading — avatar, name, time, text on the page surface.
 * `bubble` is the object-detail timeline reading (mockup 1236–1243): a 30px
 * avatar ringed in the page colour so it sits over the timeline rail, and the
 * message body in a muted rounded card with the name and time inside it.
 */
export type CommentVariant = 'plain' | 'bubble'

interface CommentRowProps {
	event: EventResponse
	actors: ActorListItem[]
	workspaceId: string
	onReply?: (authorName: string) => void
	isUnread?: boolean
	isDecisionPoint?: boolean
	variant?: CommentVariant
	/** Rendered under the message text — inside the bubble when bubbled, so the
	 *  thread toggle reads as part of the message. */
	footer?: React.ReactNode
}

function CommentRow({
	event,
	actors,
	workspaceId,
	onReply,
	isUnread,
	isDecisionPoint,
	variant = 'plain',
	footer,
}: CommentRowProps) {
	const isBubble = variant === 'bubble'
	const [expanded, setExpanded] = useState(false)
	const { data: actor } = useActor(event.actorId)
	const content = (event.data?.content as string) ?? ''
	const attachmentFileIds = (event.data?.attachmentFileIds as string[] | undefined) ?? []
	// Scope the lookup to exactly the ids this comment references. An unfiltered
	// useFiles(workspaceId) resolves against the 50 newest workspace files
	// (apps/dev/src/routes/files.ts), so every attachment older than that window
	// silently rendered as nothing at all.
	const { data: attachedFiles, isPending: attachmentsPending } = useFiles(workspaceId, {
		ids: attachmentFileIds,
	})
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
	const clampable = isBubble && content.length > CLAMP_OVER
	const referencedObjectIds = readReferencedObjectIds(event)
	const legacyChips = legacyChipsOf(event)

	const avatarClass = isBubble
		? 'size-[30px] border-[3px] border-background text-[11px]'
		: undefined

	const avatarEl = actor ? (
		isAgent ? (
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: actor.id }}
				aria-hidden="true"
				tabIndex={-1}
			>
				<ActorAvatar name={actor.name} type={actor.type} size="sm" className={avatarClass} />
			</Link>
		) : (
			<ActorAvatar
				name={actor.name}
				type={actor.type}
				size="sm"
				className={avatarClass}
				onClick={() => setHumanDialogActorId(actor.id)}
			/>
		)
	) : null

	const showMoreButton = clampable ? (
		<button
			type="button"
			onClick={() => setExpanded((open) => !open)}
			aria-expanded={expanded}
			className="ml-1.5 whitespace-nowrap text-[11.5px] font-semibold text-secondary-foreground hover:underline"
		>
			{expanded ? 'Show less' : 'Show more'}
		</button>
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
					'relative flex items-start rounded-md transition-colors',
					// Mockup 1281–1284: 24px avatar, 10px gutter, 2px of vertical air —
					// the timeline is read as a stream, so rows sit close together.
					isBubble ? 'z-[1] gap-2.5 py-0.5' : '-mx-1 gap-2 px-1 py-1 hover:bg-secondary/50',
					isDecisionPoint && !isBubble && 'pl-3',
				)}
			>
				{isDecisionPoint && !isBubble && (
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
				<div
					className={cn(
						'flex-1 min-w-0',
						isBubble && 'rounded-[11px] bg-muted/60 px-2.5 py-1.5 text-[12.5px] leading-[1.5]',
					)}
				>
					{/* Bubbled, the name and time run inline with the message so a
					    long history stays on one screen (mockup 1285). */}
					{isBubble ? (
						<>
							{nameEl}
							<RelativeTime
								date={event.createdAt}
								className="mx-1.5 font-mono text-[10px] tabular-nums text-border-strong"
							/>
							{isDecisionPoint && (
								<span className="mr-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent-foreground">
									Needs you
								</span>
							)}
						</>
					) : (
						<div className="flex items-baseline gap-2">
							<div className="min-w-0 flex flex-1 items-baseline gap-1.5 flex-wrap">
								{nameEl}
								{isDecisionPoint && (
									<span className="text-[10px] font-medium leading-none px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground">
										Needs you
									</span>
								)}
							</div>
							<RelativeTime
								date={event.createdAt}
								className="text-muted-foreground font-mono tabular-nums shrink-0 w-14 text-right text-xs"
							/>
						</div>
					)}
					{/* Clamped or whole, the message renders through the same markdown
					    path — an excerpt is still markdown, and rendering it raw showed
					    literal `**`, `- ` and link syntax on the most common row of the
					    timeline. Clamped, it stays inline so "Show more" can sit on the
					    end of the sentence rather than under it (mockup 1285–1286). */}
					<>
						<AgentOutput
							content={clampable && !expanded ? clampComment(content) : content}
							disallowedElements={COMMENT_DISALLOWED_ELEMENTS}
							mentionActors={actors}
							onMentionClick={handleMentionClick}
							size="sm"
							className={cn(
								isBubble || (clampable && !expanded)
									? 'inline [&_p:first-child]:inline [&_p]:my-0'
									: 'mt-1',
							)}
							renderVisuals
						/>
						{clampable && showMoreButton}
					</>

					{footer && <div>{footer}</div>}
					{/* Objects the author attached from the composer, as real
					    references (mockup `refList`). */}
					{referencedObjectIds.length > 0 && (
						<div className="mt-2 flex flex-wrap gap-1.5">
							{referencedObjectIds.map((refId) => (
								<ObjectReference
									key={refId}
									objectId={refId}
									workspaceId={workspaceId}
									variant="inline"
									className="text-xs"
								/>
							))}
						</div>
					)}
					{hasTaskList(event) && <CommentTaskList event={event} workspaceId={workspaceId} />}
					{/* Options from a comment written before `decision` replaced
					    `metadata.chips`. They never lived in the comment's own text, so
					    without this the reader sees a question with its choices missing.
					    Text, not buttons: the mechanism is gone and these are not a
					    decision — the reader answers in the composer below. */}
					{legacyChips.length > 0 && (
						<p className="text-muted-foreground mt-1.5 text-xs">
							Options offered: {legacyChips.join(' · ')}
						</p>
					)}
					{attachmentFileIds.length > 0 && (
						<ul className="mt-1.5 space-y-1">
							{attachmentFileIds.map((fileId) => {
								const file = attachedFiles?.find((f) => f.id === fileId)
								// Still loading: render nothing rather than flash "unavailable".
								if (!file) {
									if (attachmentsPending) return null
									// Resolved and absent — the file was deleted or is not visible
									// to this actor. Say so instead of dropping the attachment.
									return (
										<li key={fileId} className="text-muted-foreground text-xs italic">
											Attachment unavailable
										</li>
									)
								}
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
						onClick={() => onReply(actor?.name ?? 'this message')}
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
	onReplyTo,
	collapsibleReplies,
	variant = 'plain',
}: ActivityCommentProps) {
	const { data: actors } = useActors(workspaceId)
	const [showReplyInput, setShowReplyInput] = useState(false)
	const hasReplies = replies.length > 0
	const actorList = actors ?? []
	const isDecisionPoint = hasDecision(event)
	// Collapsed by default when the caller opts in — the toggle carries the
	// count and a note naming who spoke last, both read off the replies
	// themselves (mockup 369).
	const [repliesOpen, setRepliesOpen] = useState(false)
	const collapsed = !!collapsibleReplies && hasReplies && !repliesOpen
	const lastReply = replies[replies.length - 1]
	const lastReplyAuthor = actorList.find((a) => a.id === lastReply?.actorId)?.name
	const threadNote = lastReplyAuthor ? `last from ${lastReplyAuthor}` : null

	const handleReply = (authorName: string) => {
		if (onReplyTo) {
			onReplyTo(event, authorName)
			return
		}
		setShowReplyInput(true)
	}

	const isBubble = variant === 'bubble'

	// Mockup 1288: the thread toggle is a pill inside the message, carrying just
	// the count. The plain reading keeps the "last from <name>" note, which the
	// feed has room for.
	const threadToggle = collapsed ? (
		<button
			type="button"
			onClick={() => setRepliesOpen(true)}
			aria-expanded={false}
			className={cn(
				'mt-1.5 inline-flex items-center gap-2 text-left',
				isBubble
					? 'rounded-full border border-border bg-background px-[11px] py-1 transition-colors hover:border-brand-subtle'
					: 'ml-7 gap-1.5',
			)}
		>
			<span
				className={cn(
					'text-[11px] font-semibold',
					isBubble ? 'text-brand' : 'text-muted-foreground hover:text-foreground',
				)}
			>
				{replies.length} {replies.length === 1 ? 'reply' : 'replies'}
			</span>
			{threadNote && !isBubble && (
				<span className="text-[10.5px] text-muted-foreground">· {threadNote}</span>
			)}
			<ChevronDown size={11} className="text-muted-foreground" aria-hidden />
		</button>
	) : null

	// The ask's own options, under the message that raised them. The timeline
	// marks a decision comment as needing the reader, so it has to be answerable
	// here too — badging a call and then sending the reader elsewhere to make it
	// is the state this replaced.
	const decisionBlock = isDecisionPoint ? (
		<CommentDecisionBlock
			event={event}
			workspaceId={workspaceId}
			objectId={objectId}
			replies={replies}
		/>
	) : null
	const rowFooter =
		decisionBlock || (isBubble && threadToggle) ? (
			<>
				{decisionBlock}
				{isBubble ? threadToggle : null}
			</>
		) : undefined

	return (
		<div id={`comment-${event.id}`} className="group">
			<CommentRow
				event={event}
				actors={actorList}
				workspaceId={workspaceId}
				onReply={hasReplies && !onReplyTo ? undefined : handleReply}
				isUnread={isUnread}
				isDecisionPoint={isDecisionPoint}
				variant={variant}
				footer={rowFooter}
			/>

			{mentionSessions.length > 0 && (
				<div className={cn('mt-1 space-y-1', isBubble ? 'ml-[41px]' : 'ml-7')}>
					{mentionSessions.map((session) => (
						<MentionSessionCard key={session.id} session={session} workspaceId={workspaceId} />
					))}
				</div>
			)}

			{!isBubble && threadToggle}

			{hasReplies && !collapsed && (
				<div className={cn('space-y-1.5', variant === 'bubble' ? 'ml-[41px]' : 'ml-7')}>
					{replies.map((reply, idx) => (
						<div key={reply.id}>
							{divider && dividerBeforeReplyId === reply.id && divider}
							<CommentRow
								event={reply}
								actors={actorList}
								workspaceId={workspaceId}
								onReply={idx === replies.length - 1 ? handleReply : undefined}
								variant={variant}
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
