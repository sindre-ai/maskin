import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import type { ConversationListItemResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

interface ConversationListRowProps {
	workspaceId: string
	conversation: ConversationListItemResponse
}

/** How many participant plates the row draws before collapsing to a `+N`. */
const MAX_ROW_AVATARS = 2

export function ConversationListRow({ workspaceId, conversation }: ConversationListRowProps) {
	// Counterparts first, the viewer last (mockup 6106–6108) — a one-to-one
	// thread should read as "the agent's row", but once several people are in
	// it, leaving yourself out misrepresents who is in the room. A thread with
	// nobody else falls back to its own participants so the row is never
	// plateless.
	const self = getStoredActor()
	const others = conversation.participants.filter((p) => p.actorId !== self?.id)
	const me = conversation.participants.filter((p) => p.actorId === self?.id)
	const roster = others.length > 0 ? [...others, ...me] : conversation.participants
	// One counterpart is drawn as a single large plate; a group shrinks to
	// overlapping tiles so the extra identities fit the same column width.
	const isGroup = others.length > 1
	const counterparts = isGroup ? roster : roster.slice(0, 1)
	const visible = counterparts.slice(0, MAX_ROW_AVATARS)
	const overflow = counterparts.length - visible.length
	const isUnread = conversation.unread_count > 0
	const snippetAuthor = conversation.snippet_actor_id
		? conversation.snippet_actor_id === self?.id
			? 'You'
			: conversation.snippet_actor_name
		: null

	return (
		<Link
			to="/$workspaceId/chats/$conversationId"
			params={{ workspaceId, conversationId: conversation.id }}
			// `--row-surface` is what the overlapping avatar ring is cut in, so it
			// has to track the row's own background through rest / hover / selected
			// — a ring pinned to the pane colour shows a halo the moment the row
			// tints (mockup 6109's `ring` switching with the selected state).
			activeProps={{ className: 'bg-accent [--row-surface:var(--accent)]' }}
			className="flex items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left [--row-surface:var(--surface-sunken)] hover:bg-accent hover:[--row-surface:var(--accent)]"
		>
			{visible.length > 0 ? (
				// Decorative: the row's title and snippet already name who is
				// talking, and initials read aloud as "B A, R E, plus three" are
				// noise. Labelling them also put every participant's name into the
				// row link's accessible name, where it collided with lookups
				// scoped to the row (the unread badge).
				<span className="mt-px flex shrink-0 items-center" aria-hidden>
					{visible.map((p, index) => (
						<ActorAvatar
							key={p.actorId}
							id={p.actorId}
							name={p.actorName}
							type={p.actorType}
							size={isGroup ? 'sm' : 'md'}
							className={cn(
								'relative',
								isGroup
									? // The ring is cut in the row's own colour so overlapping
										// tiles read as separate plates rather than one blob.
										'size-[19px] rounded-md text-[8px]'
									: 'size-[26px] rounded-lg text-[10px]',
								// The leading plate sits on top of the ones it overlaps, so
								// the stack reads left-to-right in order of who is talking.
								index === 0 ? 'z-10' : '-ml-1.5 z-0 ring-[1.5px] ring-[var(--row-surface)]',
							)}
						/>
					))}
					{overflow > 0 ? (
						<span
							className={cn(
								'relative -ml-1.5 inline-grid shrink-0 place-items-center bg-muted font-bold text-muted-foreground ring-[1.5px] ring-[var(--row-surface)]',
								isGroup
									? 'size-[19px] rounded-md text-[8px]'
									: 'size-[26px] rounded-lg text-[10px]',
							)}
						>
							+{overflow}
						</span>
					) : null}
				</span>
			) : null}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					{isUnread ? (
						<span
							aria-label={`${conversation.unread_count} unread`}
							// Indigo, not ink (mockup 283): the row's title is already ink,
							// so an ink dot beside it reads as punctuation rather than state.
							className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
						/>
					) : null}
					<span
						className={cn(
							'min-w-0 flex-1 truncate text-[12.5px] tracking-[-0.01em] text-foreground',
							isUnread ? 'font-bold' : 'font-medium',
						)}
					>
						{conversation.title}
					</span>
					<RelativeTime
						date={conversation.lastMessageAt ?? conversation.createdAt}
						format="clock"
						className="shrink-0 text-[10px] text-muted-foreground"
					/>
				</div>
				<span className="mt-0.5 line-clamp-2 text-[11.5px] leading-[1.4] text-muted-foreground">
					{/* "Forge: …" / "You: …" — a preview with no attribution reads as
					    if the viewer wrote every line (mockup 296). */}
					{conversation.snippet ? (
						<>
							{snippetAuthor ? <span className="font-medium">{snippetAuthor}: </span> : null}
							{conversation.snippet}
						</>
					) : (
						'No messages yet'
					)}
				</span>
			</div>
		</Link>
	)
}
