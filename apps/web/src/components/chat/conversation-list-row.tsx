import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import type { ConversationListItemResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { plainPreview } from '@/lib/linked-objects'
import { Link } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'

interface ConversationListRowProps {
	workspaceId: string
	conversation: ConversationListItemResponse
	/** Unread replies in this chat's threads (0 when none). Chat unread and thread unread are
	 *  separate reads, so a chat can look read while a thread inside it is not. */
	threadUnread?: number
}

/**
 * One chat in the list (mockup v11): a 32px tile with the counterpart's
 * initials, the name and time on the first line, a one-line preview on the
 * second, and a `···` menu. Unread chats carry a bold name, a cobalt tile and
 * a dot before the preview.
 */
export function ConversationListRow({
	workspaceId,
	conversation,
	threadUnread = 0,
}: ConversationListRowProps) {
	// Counterparts first, the viewer last: a one-to-one thread reads as "the
	// agent's row". A thread with nobody else falls back to its own participants.
	const self = getStoredActor()
	const updateMe = useUpdateConversationMe(workspaceId)
	const others = conversation.participants.filter((p) => p.actorId !== self?.id)
	const lead = others[0] ?? conversation.participants[0]
	const isUnread = conversation.unread_count > 0
	const workingActorIds = new Set(conversation.working_actor_ids)
	const workingNames = conversation.participants
		.filter((p) => workingActorIds.has(p.actorId))
		.map((p) => p.actorName)
	// An agent's own message is the best status there is — it says what it is doing — so the
	// preview shows it as soon as one arrives. "Working" only covers the gap before that: the
	// latest message is the person's and no agent has answered yet. A chat session stays live
	// between turns, so the working flag alone must never outrank a message the agent sent.
	const latestFromAgent = conversation.participants.some(
		(p) => p.actorType === 'agent' && p.actorId === conversation.snippet_actor_id,
	)
	const workingLabel =
		workingNames.length === 0 || latestFromAgent
			? null
			: workingNames.length === 1
				? `${workingNames[0]} is working…`
				: `${workingNames.length} agents are working…`
	const snippetAuthor = conversation.snippet_actor_id
		? conversation.snippet_actor_id === self?.id
			? 'You'
			: // Named only where the title doesn't already: with three or more people in the chat.
				conversation.participants.length > 2
				? conversation.snippet_actor_name
				: null
		: null

	return (
		<div className="group/row relative border-t border-border first:border-t-0">
			<Link
				to="/$workspaceId/chats/$conversationId"
				params={{ workspaceId, conversationId: conversation.id }}
				activeProps={{ className: 'bg-accent' }}
				className="flex items-start gap-3 rounded-lg px-2 py-[11px] text-left hover:bg-accent"
			>
				{lead ? (
					// The row's title and snippet already name who is talking; agents get their pictogram.
					<ActorAvatar
						name={lead.actorName}
						type={lead.actorType}
						id={lead.actorId}
						size="md"
						className={cn(
							'mt-px size-8 shrink-0 rounded-[9px] text-[11px] font-bold',
							isUnread
								? 'bg-brand-subtle text-brand-subtle-foreground'
								: 'bg-secondary text-foreground',
						)}
					/>
				) : null}
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 pr-7">
						<span
							className={cn(
								'min-w-0 flex-1 truncate text-sm text-foreground',
								isUnread ? 'font-bold' : 'font-semibold',
							)}
						>
							{conversation.title}
						</span>
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
						{isUnread ? (
							<span
								role="img"
								aria-label={`${conversation.unread_count} unread`}
								className="size-1.5 shrink-0 rounded-full bg-brand"
							/>
						) : null}
						<span className="min-w-0 truncate">
							{/* "Forge: …" / "You: …" — a preview with no attribution reads as
							    if the viewer wrote every line. */}
							{workingLabel ? (
								<span className="font-medium">{workingLabel}</span>
							) : conversation.snippet ? (
								<>
									{snippetAuthor ? <span className="font-medium">{snippetAuthor}: </span> : null}
									{plainPreview(conversation.snippet).map((part, index) =>
										part.muted ? (
											// biome-ignore lint/suspicious/noArrayIndexKey: parts are rebuilt from the text on every render and never reorder
											<span key={index} className="opacity-80">
												{part.text}
											</span>
										) : (
											part.text
										),
									)}
								</>
							) : (
								'No messages yet'
							)}
						</span>
						<RelativeTime
							date={conversation.lastMessageAt ?? conversation.createdAt}
							format="clock"
							className="ml-auto shrink-0 text-xs"
						/>
					</div>
					{threadUnread > 0 ? (
						<span className="mt-0.5 block text-[11px] font-medium text-brand">
							{threadUnread} unread {threadUnread === 1 ? 'reply' : 'replies'} in threads
						</span>
					) : null}
				</div>
			</Link>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						aria-label={`Actions for ${conversation.title}`}
						className="absolute top-[9px] right-2 grid h-[22px] w-6 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<MoreHorizontal size={14} aria-hidden />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						onSelect={() =>
							updateMe.mutate({ id: conversation.id, data: { pinned: !conversation.pinned } })
						}
					>
						{conversation.pinned ? 'Unpin' : 'Pin'}
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() => updateMe.mutate({ id: conversation.id, data: { mark_unread: true } })}
					>
						Mark as unread
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() =>
							updateMe.mutate({ id: conversation.id, data: { archived: !conversation.archived } })
						}
					>
						{conversation.archived ? 'Unarchive' : 'Archive'}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}
