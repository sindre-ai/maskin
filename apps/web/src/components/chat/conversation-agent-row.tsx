import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import type { ConversationListItemResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { ConversationListEntry } from '@/lib/conversation-agent-rows'
import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { ConversationListRow } from './conversation-list-row'

type AgentEntry = Extract<ConversationListEntry, { kind: 'agent' }>

/** Chats listed under an agent before "Show N more". */
export const AGENT_FOLD_CAP = 4

/** A direct message has no topic, so it is named for what it is. */
function chatLabel(c: ConversationListItemResponse): string {
	return c.directPairKey ? 'Direct message' : c.title
}

/**
 * One agent in the Agents view: its name, "N chats · newest title", unread summed over its chats.
 * Tapping the row opens the newest chat; the chevron folds the rest underneath.
 */
export function ConversationAgentRow({
	workspaceId,
	entry,
	threadUnreadByChat,
	onOpen,
}: {
	workspaceId: string
	entry: AgentEntry
	/** Unread thread replies per chat, so a folded chat that is caught up still shows its threads. */
	threadUnreadByChat: Map<string, number>
	/** A chat under this row was opened (the row itself opens the newest). */
	onOpen?: (conversationId: string) => void
}) {
	const [open, setOpen] = useState(false)
	const [showAll, setShowAll] = useState(false)
	const { agent, conversations, unread } = entry
	const newest = conversations[0]
	const shown = showAll ? conversations : conversations.slice(0, AGENT_FOLD_CAP)
	const hidden = conversations.length - shown.length
	const isUnread = unread > 0
	return (
		<div data-testid="agent-row" className="flex flex-col">
			<div className="group/row relative border-t border-border first:border-t-0">
				<Link
					to="/$workspaceId/chats/$conversationId"
					params={{ workspaceId, conversationId: newest.id }}
					onClick={() => onOpen?.(newest.id)}
					className="flex items-start gap-3 rounded-lg px-2 py-[11px] text-left hover:bg-accent"
				>
					<ActorAvatar
						name={agent.actorName}
						type={agent.actorType}
						id={agent.actorId}
						size="md"
						className="mt-px size-8 shrink-0"
					/>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5 pr-7">
							<span
								className={cn(
									'min-w-0 flex-1 truncate text-sm text-foreground',
									isUnread ? 'font-bold' : 'font-semibold',
								)}
							>
								{agent.actorName}
							</span>
						</div>
						<div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
							<span className="min-w-0 truncate">
								{conversations.length} chats · {chatLabel(newest)}
							</span>
							{isUnread ? (
								<span
									role="img"
									aria-label={`${unread} unread`}
									className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-brand px-1 font-semibold text-[11px] text-brand-foreground"
								>
									{unread}
								</span>
							) : null}
							<RelativeTime
								date={newest.lastMessageAt ?? newest.createdAt}
								format="clock"
								className="ml-auto shrink-0 text-xs"
							/>
						</div>
					</div>
				</Link>
				<button
					type="button"
					aria-expanded={open}
					aria-label={`${open ? 'Fold' : 'Unfold'} ${conversations.length} chats with ${agent.actorName}`}
					onClick={() => setOpen((prev) => !prev)}
					className="absolute top-[9px] right-2 grid h-[22px] w-6 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ChevronDown
						size={14}
						aria-hidden
						className={cn('transition-transform', !open && '-rotate-90')}
					/>
				</button>
			</div>
			{open ? (
				<div className="ml-5 flex flex-col border-l border-border pl-2">
					{shown.map((c) => (
						<ConversationListRow
							key={c.id}
							workspaceId={workspaceId}
							conversation={c}
							threadUnread={threadUnreadByChat.get(c.id) ?? 0}
							label={chatLabel(c)}
							onOpen={() => onOpen?.(c.id)}
						/>
					))}
					{hidden > 0 ? (
						<button
							type="button"
							onClick={() => setShowAll(true)}
							className="px-2 py-2 text-left font-semibold text-[12.5px] text-muted-foreground hover:text-foreground"
						>
							Show {hidden} more
						</button>
					) : null}
				</div>
			) : null}
		</div>
	)
}
