import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { useChatRowActions } from '@/hooks/use-chat-row-actions'
import type { ChatListErrorReason, ConversationListItemResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { previewMarker } from '@/lib/chat-list-v2'
import { cn } from '@/lib/cn'
import { plainPreview } from '@/lib/linked-objects'
import { Link } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { ConversationAvatarStack } from '../conversation-avatar-stack'

type RowActions = ReturnType<typeof useChatRowActions>

/** The reason line on a stopped chat, verbatim from the states addendum. */
export const ERROR_COPY: Record<ChatListErrorReason, string> = {
	usage_limit: 'Stopped. Usage limit reached.',
	other: 'Stopped. Something went wrong.',
	connection: 'Stopped. Connection dropped.',
}

const ERROR_LABEL: Record<ChatListErrorReason, string> = {
	usage_limit: 'Stopped, usage limit reached',
	other: 'Stopped, something went wrong',
	connection: 'Stopped, connection dropped',
}

interface ChatRowProps {
	workspaceId: string
	conversation: ConversationListItemResponse
	actions: RowActions
	/** Unread replies in this chat's threads (0 when none); a chat can look read while one is not. */
	threadUnread?: number
	/** The row was opened from the list (click or Enter). */
	onOpen?: () => void
}

const HOVER_BUTTON =
	'hidden h-6 items-center rounded-full px-2 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring can-hover:inline-flex'

/**
 * One chat in the new list: three lines (agent names and time, title, a two-line preview), a gutter
 * dot for unread, and at most one marker on the preview line (error, needs you, working). Row
 * actions sit top right: on hover where hover exists, and always behind the ··· button.
 */
export function ChatRow({
	workspaceId,
	conversation,
	actions,
	threadUnread = 0,
	onOpen,
}: ChatRowProps) {
	const self = getStoredActor()
	const others = conversation.participants.filter((p) => p.actorId !== self?.id)
	const lead = others[0] ?? conversation.participants[0]
	const isDirect = !!conversation.directPairKey
	const names = (others.length > 0 ? others : conversation.participants)
		.map((p) => p.actorName)
		.join(', ')
	const title = isDirect ? 'Direct message' : conversation.title
	const isUnread = conversation.unread_count > 0
	const marker = previewMarker(conversation)
	const error = conversation.error
	const canRetry = error?.last_person_message_id != null
	const workingIds = new Set((conversation.working ?? []).map((w) => w.agent_id))
	const workingNames = conversation.participants
		.filter((p) => workingIds.has(p.actorId))
		.map((p) => p.actorName)

	const preview = conversation.snippet
		? plainPreview(conversation.snippet).map((part, index) =>
				part.muted ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: parts are rebuilt from the text on every render and never reorder
					<span key={index} className="opacity-80">
						{part.text}
					</span>
				) : (
					part.text
				),
			)
		: 'No messages yet'

	return (
		<div
			data-testid="chat-row"
			className="group/row relative border-t border-border first:border-t-0"
			style={{ '--cluster-w': canRetry ? '176px' : '128px' } as React.CSSProperties}
		>
			{isUnread ? (
				<span
					role="img"
					aria-label="Unread"
					className="absolute top-[18px] left-0 size-[7px] rounded-full bg-brand lg:-left-3.5"
				/>
			) : null}
			<Link
				to="/$workspaceId/chats/$conversationId"
				params={{ workspaceId, conversationId: conversation.id }}
				onClick={onOpen}
				data-chat-row-link
				activeProps={{ className: 'bg-accent' }}
				className="flex items-start gap-3 rounded-lg px-2 py-[11px] text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				{others.length > 1 ? (
					<ConversationAvatarStack participants={others} className="mt-1 w-[46px]" />
				) : lead ? (
					<ActorAvatar
						name={lead.actorName}
						type={lead.actorType}
						id={lead.actorId}
						size="md"
						className="mt-px size-8 shrink-0"
					/>
				) : null}
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span
							className={cn(
								'min-w-0 flex-1 truncate text-[14.5px] text-foreground',
								isUnread ? 'font-bold' : 'font-semibold',
							)}
						>
							{names}
						</span>
						{conversation.pinned ? (
							<span className="shrink-0 text-xs text-muted-foreground">Pinned</span>
						) : null}
						<RelativeTime
							date={conversation.lastMessageAt ?? conversation.createdAt}
							format="clock"
							className="mr-8 shrink-0 text-xs text-muted-foreground can-hover:group-focus-within/row:mr-(--cluster-w) can-hover:group-hover/row:mr-(--cluster-w) max-sm:mr-9"
						/>
					</div>
					<div className="mt-0.5 truncate text-sm font-medium text-foreground">{title}</div>
					<div className="mt-0.5 flex items-start gap-1.5 text-[13px] text-muted-foreground">
						{marker === 'error' ? (
							<span
								role="img"
								aria-label={error ? ERROR_LABEL[error.reason] : 'Stopped'}
								className="mt-[5px] size-2 shrink-0 rounded-full bg-error"
							/>
						) : marker === 'needs_you' ? (
							<span
								role="img"
								aria-label="Needs you"
								className="mt-[5px] size-2 shrink-0 rounded-full bg-warning"
							/>
						) : marker === 'working' ? (
							<span
								role="img"
								aria-label="Working"
								className="mt-[3px] size-[11px] shrink-0 rounded-full border-[1.5px] border-muted-foreground border-t-foreground"
							/>
						) : null}
						<span
							className={cn(
								'line-clamp-2 min-w-0',
								marker === 'error' && 'font-medium text-error',
								marker === 'needs_you' && 'font-medium text-foreground',
							)}
						>
							{marker === 'error' && error
								? ERROR_COPY[error.reason]
								: marker === 'working' && workingNames.length > 0
									? `${workingNames.join(', ')} ${workingNames.length === 1 ? 'is' : 'are'} working…`
									: preview}
						</span>
					</div>
					{threadUnread > 0 ? (
						<span className="mt-0.5 block text-[11px] font-medium text-brand">
							{threadUnread} unread {threadUnread === 1 ? 'reply' : 'replies'} in threads
						</span>
					) : null}
				</div>
			</Link>
			<div
				className={cn(
					'absolute top-[9px] right-2 flex items-center gap-0.5 max-sm:top-1',
					'can-hover:opacity-0 can-hover:focus-within:opacity-100 can-hover:group-hover/row:opacity-100',
				)}
			>
				{canRetry ? (
					<button
						type="button"
						className={HOVER_BUTTON}
						onClick={() => actions.retry(conversation, 'hover')}
					>
						Retry
					</button>
				) : null}
				<button
					type="button"
					className={HOVER_BUTTON}
					onClick={() => actions.done(conversation, 'hover')}
				>
					Done
				</button>
				<button
					type="button"
					className={HOVER_BUTTON}
					onClick={() => actions.later(conversation, 'hover')}
				>
					Later
				</button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={`Actions for ${conversation.title}`}
							className="relative grid h-6 w-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:size-11 touch-hit"
						>
							<MoreHorizontal size={14} aria-hidden />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{canRetry ? (
							<DropdownMenuItem onSelect={() => actions.retry(conversation, 'menu')}>
								Retry
							</DropdownMenuItem>
						) : null}
						<DropdownMenuItem onSelect={() => actions.done(conversation, 'menu')}>
							Done
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => actions.later(conversation, 'menu')}>
							Later
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => actions.togglePinned(conversation)}>
							{conversation.pinned ? 'Unpin' : 'Pin'}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() =>
								isUnread ? actions.markRead(conversation) : actions.markUnread(conversation)
							}
						>
							{isUnread ? 'Mark as read' : 'Mark as unread'}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	)
}
