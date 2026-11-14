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
import { badgeCount, hasQuietNews } from '@/lib/chat-list-sections'
import { cn } from '@/lib/cn'
import { shortActorName, snippetAuthorLabel } from '@/lib/conversation-snippet'
import { plainPreview } from '@/lib/linked-objects'
import { Link } from '@tanstack/react-router'
import { Hash, MoreHorizontal, Pin, Repeat } from 'lucide-react'
import type { ReactNode } from 'react'
import { ConversationAvatarStack } from './conversation-avatar-stack'

interface ConversationListRowProps {
	workspaceId: string
	conversation: ConversationListItemResponse
	/** Unread replies in this chat's threads (0 when none). Chat unread and thread unread are
	 *  separate reads, so a chat can look read while a thread inside it is not. */
	threadUnread?: number
	/** Names the row when its own title would repeat the line above it (a direct message folded
	 *  under its agent reads "Direct message"). */
	label?: string
	/** The row was clicked or opened with the keyboard (not the `···` menu). */
	onOpen?: () => void
	/** Sectioned list only: the number counts mentions plus open cards, new messages alone show
	 *  a hollow dot, and a pinned chat in a section carries a pin glyph. */
	sectioned?: boolean
	/** Sectioned list only: why the chat is in a view ("Mentions you: ..."), in place of the preview. */
	reason?: string | null
	/** Sectioned list only: extra items for the `···` menu, above Pin ("Move to section"). */
	menuExtra?: ReactNode
	/** Sectioned list only: where the chat lives, as a small chip beside the time (view lists). */
	chip?: string | null
	/** Sectioned list only: the pin glyph shows beside the name (a pinned chat inside a section). */
	showPin?: boolean
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
	label,
	onOpen,
	sectioned = false,
	reason,
	menuExtra,
	showPin = false,
	chip,
}: ConversationListRowProps) {
	// Counterparts first, the viewer last: a one-to-one thread reads as "the
	// agent's row". A thread with nobody else falls back to its own participants.
	const self = getStoredActor()
	const updateMe = useUpdateConversationMe(workspaceId)
	const others = conversation.participants.filter((p) => p.actorId !== self?.id)
	const lead = others[0] ?? conversation.participants[0]
	// A direct message is the pair's own line, so it is named after who is on the other end.
	// Whatever title it was created with is not a topic.
	const title =
		label ?? (conversation.directPairKey && others[0] ? others[0].actorName : conversation.title)
	// Sectioned: the number is mentions plus open cards (every message in a direct chat), and news
	// with nothing for the viewer is a hollow dot that adds 0.
	const badge = sectioned ? badgeCount(conversation) : 0
	const hollowDot = sectioned && badge === 0 && hasQuietNews(conversation)
	const isUnread = sectioned ? badge > 0 : conversation.unread_count > 0
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
	// The title rendered below is `title`; compare against exactly that.
	const snippetAuthor = snippetAuthorLabel(conversation, title, self?.id)

	return (
		<div className="group/row relative border-t border-border first:border-t-0">
			<Link
				to="/$workspaceId/chats/$conversationId"
				params={{ workspaceId, conversationId: conversation.id }}
				onClick={onOpen}
				activeProps={{ className: 'bg-accent' }}
				className="flex items-start gap-3 rounded-lg px-2 py-[11px] text-left hover:bg-accent"
			>
				{conversation.roomKind ? (
					// A room is a square tile, not people: arrows for a flow's room, # for one a person made.
					<span
						role="img"
						aria-label={conversation.roomKind === 'flow' ? 'Flow room' : 'Room'}
						className="mt-px grid size-8 shrink-0 place-items-center rounded-[10px] bg-secondary text-foreground"
					>
						{conversation.roomKind === 'flow' ? (
							<Repeat size={15} aria-hidden />
						) : (
							<Hash size={15} aria-hidden />
						)}
					</span>
				) : others.length > 1 ? (
					// Several actors: the cluster the iPhone list draws, so nobody is hidden behind one icon.
					<ConversationAvatarStack participants={others} className="mt-1 w-[46px]" />
				) : lead ? (
					// The row's title and snippet already name who is talking; agents show their initials too.
					<ActorAvatar
						name={lead.actorName}
						type={lead.actorType}
						id={lead.actorId}
						size="md"
						className="mt-px size-8 shrink-0"
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
							{title}
						</span>
						{showPin ? (
							<Pin
								size={12}
								aria-label="Pinned"
								role="img"
								className="shrink-0 text-muted-foreground"
							/>
						) : null}
						{sectioned && badge > 0 ? (
							<span
								role="img"
								aria-label={`${badge} waiting on you`}
								className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-brand px-1 text-[11px] font-bold text-white"
							>
								{badge}
							</span>
						) : null}
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
						{sectioned ? (
							hollowDot ? (
								<span
									role="img"
									aria-label="New messages, nothing needs you"
									className="size-1.5 shrink-0 rounded-full border border-muted-foreground"
								/>
							) : null
						) : isUnread ? (
							<span
								role="img"
								aria-label={`${conversation.unread_count} unread`}
								className="size-1.5 shrink-0 rounded-full bg-brand"
							/>
						) : null}
						<span className="min-w-0 truncate">
							{/* "Forge: …" / "You: …" — a preview with no attribution reads as
							    if the viewer wrote every line. */}
							{reason ? (
								<span className="font-medium text-brand-subtle-foreground">{reason}</span>
							) : workingLabel ? (
								<span className="font-medium">{workingLabel}</span>
							) : conversation.snippet ? (
								<>
									{snippetAuthor ? (
										<span className="font-medium" title={snippetAuthor}>
											{/* The list has no room for "Chief of Staff": it reads "CoS". */}
											{shortActorName(snippetAuthor)}:{' '}
										</span>
									) : null}
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
						{chip ? (
							<span className="ml-auto max-w-[40%] shrink-0 truncate rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium">
								{chip}
							</span>
						) : null}
						<RelativeTime
							date={conversation.lastMessageAt ?? conversation.createdAt}
							format="clock"
							className={cn('shrink-0 text-xs', !chip && 'ml-auto')}
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
						aria-label={`Actions for ${title}`}
						className="absolute top-[9px] right-2 grid h-[22px] w-6 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<MoreHorizontal size={14} aria-hidden />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{menuExtra}
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
