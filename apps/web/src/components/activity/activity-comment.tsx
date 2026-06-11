import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useActor, useActors } from '@/hooks/use-actors'
import { useEditComment } from '@/hooks/use-events'
import { useFiles } from '@/hooks/use-files'
import { useIsMobile } from '@/hooks/use-mobile'
import type { ActorListItem, EventResponse, SessionResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { COMMENT_MAX_LENGTH } from '@maskin/shared'
import { Link, useNavigate } from '@tanstack/react-router'
import { Pencil, Reply, RotateCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
import { AttachedFileCard } from '../shared/attached-file-card'
import { MarkdownContent } from '../shared/markdown-content'
import { RelativeTime } from '../shared/relative-time'
import { CommentInput } from './comment-input'
import { DecisionChips, hasDecisionChips } from './decision-chips'
import { MentionSessionCard } from './mention-session-card'

const COMMENT_DISALLOWED_ELEMENTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

const COMMENT_PROSE_OVERRIDES = cn(
	'mt-1',
	'[&_p]:!text-foreground [&_li]:!text-foreground [&_blockquote]:!text-foreground',
	'[&_p]:!my-1.5 [&_ul]:!my-1 [&_ol]:!my-1 [&_blockquote]:!my-1 [&_pre]:!my-1',
	'[&_p]:!leading-normal [&_li]:!leading-normal',
)

const MAX_EDIT_HEIGHT_PX = 134

// Long-press threshold for mobile action sheet. Matches iOS context-menu feel
// without conflicting with a normal tap.
const LONG_PRESS_MS = 450

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
	objectId: string
	onReply?: () => void
	isUnread?: boolean
	isDecisionPoint?: boolean
}

function CommentRow({
	event,
	actors,
	workspaceId,
	objectId,
	onReply,
	isUnread,
	isDecisionPoint,
}: CommentRowProps) {
	const { data: actor } = useActor(event.actorId)
	const content = (event.data?.content as string) ?? ''
	const editedAt = (event.data?.editedAt as string | undefined) ?? null
	const attachmentFileIds = (event.data?.attachmentFileIds as string[] | undefined) ?? []
	const { data: workspaceFiles } = useFiles(workspaceId)
	const [humanDialogActorId, setHumanDialogActorId] = useState<string | null>(null)
	const [isEditing, setIsEditing] = useState(false)
	const [actionSheetOpen, setActionSheetOpen] = useState(false)
	const navigate = useNavigate()
	const isMobile = useIsMobile()
	const editComment = useEditComment(workspaceId, objectId)

	const currentActorId = getStoredActor()?.id
	const isOwn = !!currentActorId && currentActorId === event.actorId

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

	const beginEdit = () => {
		setActionSheetOpen(false)
		setIsEditing(true)
	}
	const cancelEdit = () => setIsEditing(false)

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

	// Long-press → bottom Sheet on mobile. Desktop uses hover-revealed inline
	// action group; we keep the JSX wired on all viewports and let CSS/the
	// useIsMobile gate decide which surface actually shows.
	const longPressTimer = useRef<number | undefined>(undefined)
	const onTouchStart = useCallback(() => {
		if (!isOwn || !isMobile || isEditing) return
		longPressTimer.current = window.setTimeout(() => {
			setActionSheetOpen(true)
		}, LONG_PRESS_MS)
	}, [isOwn, isMobile, isEditing])
	const clearLongPress = useCallback(() => {
		if (longPressTimer.current !== undefined) {
			clearTimeout(longPressTimer.current)
			longPressTimer.current = undefined
		}
	}, [])
	useEffect(() => clearLongPress, [clearLongPress])

	return (
		<>
			<div
				className={cn(
					'relative flex items-start gap-2 py-1 px-1 -mx-1 rounded-md hover:bg-secondary/50 transition-colors',
					isDecisionPoint && 'pl-3',
				)}
				onTouchStart={onTouchStart}
				onTouchEnd={clearLongPress}
				onTouchMove={clearLongPress}
				onTouchCancel={clearLongPress}
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
						{editedAt && !isEditing && (
							<span className="text-muted-foreground text-xs" title={`Edited ${editedAt}`}>
								(edited)
							</span>
						)}
						{isDecisionPoint && (
							<span className="text-[10px] font-medium leading-none px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground">
								Needs you
							</span>
						)}
					</div>
					{isEditing ? (
						<EditComposer
							initialContent={content}
							isSaving={editComment.isPending}
							onCancel={cancelEdit}
							onSave={(next) =>
								editComment.mutate(
									{ eventId: event.id, data: { content: next } },
									{ onSuccess: () => setIsEditing(false) },
								)
							}
						/>
					) : (
						<>
							<MarkdownContent
								content={content}
								disallowedElements={COMMENT_DISALLOWED_ELEMENTS}
								mentionActors={actors}
								onMentionClick={handleMentionClick}
								size="sm"
								className={COMMENT_PROSE_OVERRIDES}
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
						</>
					)}
				</div>
				{!isEditing && (
					<CommentActions
						isOwn={isOwn}
						onEdit={beginEdit}
						onReply={onReply}
						onDelete={() => {
							/* T4 — soft-delete wiring lands separately */
						}}
						onEditAndRestart={() => {
							/* T3 — wired via useResendComment when its branch lands */
						}}
					/>
				)}
			</div>
			{isOwn && isMobile && (
				<Sheet open={actionSheetOpen} onOpenChange={setActionSheetOpen}>
					<SheetContent side="bottom" className="rounded-t-lg p-0">
						<div className="flex flex-col p-2">
							<MobileActionButton label="Edit" icon={<Pencil size={16} />} onClick={beginEdit} />
							<MobileActionButton
								label="Edit & restart agent"
								icon={<RotateCw size={16} />}
								onClick={() => {
									/* T3 — wired when resend hook lands */
									setActionSheetOpen(false)
								}}
							/>
							<MobileActionButton
								label="Delete"
								icon={<Trash2 size={16} />}
								destructive
								onClick={() => {
									/* T4 — soft-delete with 15s undo */
									setActionSheetOpen(false)
								}}
							/>
						</div>
					</SheetContent>
				</Sheet>
			)}
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

interface CommentActionsProps {
	isOwn: boolean
	onEdit: () => void
	onReply?: () => void
	onDelete: () => void
	onEditAndRestart: () => void
}

// Hover-revealed action group on the calm thread. Reply was already in this
// slot; Edit / Edit & restart agent / Delete are added for own messages only.
// Stays out of the way: hidden on touch (no hover), faded on mouse devices
// until the row is hovered or focused.
function CommentActions({
	isOwn,
	onEdit,
	onReply,
	onDelete,
	onEditAndRestart,
}: CommentActionsProps) {
	if (!isOwn && !onReply) return null

	const slotClasses = cn(
		'flex items-center gap-0.5 self-end shrink-0',
		'opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-within:opacity-100 transition-opacity',
	)

	return (
		<div className={slotClasses}>
			{isOwn && (
				<>
					<ActionIconButton label="Edit" icon={<Pencil size={14} />} onClick={onEdit} />
					<ActionIconButton
						label="Edit & restart agent"
						icon={<RotateCw size={14} />}
						onClick={onEditAndRestart}
					/>
				</>
			)}
			{onReply && <ActionIconButton label="Reply" icon={<Reply size={14} />} onClick={onReply} />}
			{isOwn && (
				<ActionIconButton
					label="Delete"
					icon={<Trash2 size={14} />}
					onClick={onDelete}
					destructive
				/>
			)}
		</div>
	)
}

function ActionIconButton({
	label,
	icon,
	onClick,
	destructive,
}: {
	label: string
	icon: React.ReactNode
	onClick: () => void
	destructive?: boolean
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				'text-muted-foreground p-1 -m-0.5 rounded-sm',
				destructive ? 'hover:text-error' : 'hover:text-foreground',
			)}
		>
			{icon}
		</button>
	)
}

function MobileActionButton({
	label,
	icon,
	onClick,
	destructive,
}: {
	label: string
	icon: React.ReactNode
	onClick: () => void
	destructive?: boolean
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				'flex items-center gap-3 px-3 py-3 min-h-[44px] rounded-md text-sm',
				'hover:bg-secondary/50',
				destructive ? 'text-error' : 'text-foreground',
			)}
		>
			<span className="text-muted-foreground">{icon}</span>
			{label}
		</button>
	)
}

interface EditComposerProps {
	initialContent: string
	isSaving: boolean
	onCancel: () => void
	onSave: (content: string) => void
}

// Inline edit-in-place composer. Replaces the message body with a textarea
// reusing the same auto-resize + max-height behaviour as comment-input.tsx.
// Two send paths in the footer: Save (passive — wires comment_edited) and
// Save & restart agent (stub for T3). Esc cancels without committing.
function EditComposer({ initialContent, isSaving, onCancel, onSave }: EditComposerProps) {
	const [content, setContent] = useState(initialContent)
	const textareaRef = useRef<HTMLTextAreaElement>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: content drives the resize even when the effect body reads scrollHeight only
	useLayoutEffect(() => {
		const ta = textareaRef.current
		if (!ta) return
		ta.style.height = 'auto'
		const overflows = ta.scrollHeight > MAX_EDIT_HEIGHT_PX
		ta.style.height = `${Math.min(ta.scrollHeight, MAX_EDIT_HEIGHT_PX)}px`
		ta.style.overflowY = overflows ? 'auto' : 'hidden'
	}, [content])

	useEffect(() => {
		const ta = textareaRef.current
		if (!ta) return
		ta.focus()
		// Place cursor at end so the user can keep typing.
		const len = ta.value.length
		ta.setSelectionRange(len, len)
	}, [])

	const trimmed = content.trim()
	const overLimit = content.length > COMMENT_MAX_LENGTH
	const unchanged = trimmed === initialContent.trim()
	const canSave = !!trimmed && !overLimit && !unchanged && !isSaving

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Escape') {
			e.preventDefault()
			onCancel()
			return
		}
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault()
			if (canSave) onSave(trimmed)
		}
	}

	return (
		<div className="mt-1">
			<div
				className={cn(
					'rounded-md border bg-background transition-colors',
					overLimit ? 'border-error' : 'border-border',
				)}
			>
				<textarea
					ref={textareaRef}
					value={content}
					onChange={(e) => setContent(e.target.value)}
					onKeyDown={handleKeyDown}
					rows={1}
					aria-label="Edit comment"
					aria-invalid={overLimit || undefined}
					className="w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm focus:outline-none focus:ring-0"
					style={{ minHeight: '32px', maxHeight: `${MAX_EDIT_HEIGHT_PX}px` }}
				/>
			</div>
			<div className="mt-1.5 flex items-center justify-end gap-1.5">
				<Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={isSaving}>
					Cancel
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => {
						/* T3 — wired through useResendComment once the resend branch lands. */
					}}
					disabled
					title="Save & restart agent — lands with T3"
				>
					Save & restart agent
				</Button>
				<Button type="button" size="sm" onClick={() => onSave(trimmed)} disabled={!canSave}>
					Save
				</Button>
			</div>
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
				objectId={objectId}
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
								objectId={objectId}
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
