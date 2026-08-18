import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import type { ConversationListItemResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

/**
 * "Assigned in chat" row (mockup 1558–1572) — work the operator handed an agent
 * directly, outside any loop cycle. It reads a conversation that has an agent
 * participant, so the row is navigable back into the thread it came from; a
 * session row would be a dead end (sessions carry no conversation link).
 */
export function AssignedInChatRow({
	conversation,
	workspaceId,
	agentName,
	agentId,
	agentType = 'agent',
	isWorking = false,
	feedsLoopName,
}: {
	conversation: ConversationListItemResponse
	workspaceId: string
	agentName: string
	agentId?: string
	agentType?: string
	/** True when that agent has a live session right now. */
	isWorking?: boolean
	/** Which loop this work feeds (mockup 1569 `k.feeds`) — the loop that runs
	 *  the agent the work was handed to. Omitted when no loop uses that agent. */
	feedsLoopName?: string
}) {
	const when = conversation.lastMessageAt ?? conversation.createdAt

	return (
		<Link
			to="/$workspaceId/chats/$conversationId"
			params={{ workspaceId, conversationId: conversation.id }}
			className="flex items-center gap-3.5 rounded-xl border border-border px-4 py-3.5 transition-colors duration-150 hover:border-border-strong"
		>
			<ActorAvatar
				id={agentId}
				name={agentName}
				type={agentType}
				size="lg"
				className="size-[34px] shrink-0 text-[11px]"
			/>
			<div className="min-w-0 flex-1 leading-[1.4]">
				<p className="truncate text-[13px] font-bold text-foreground">{conversation.title}</p>
				<div className="mt-0.5 flex min-w-0 items-center gap-1.5">
					<span className="shrink-0 text-[11.5px] font-semibold text-muted-foreground">
						{agentName}
					</span>
					{when && (
						<RelativeTime
							date={when}
							className="shrink-0 font-mono text-[10px] text-muted-foreground"
						/>
					)}
					{conversation.snippet && (
						<span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
							{conversation.snippet}
						</span>
					)}
				</div>
			</div>
			{feedsLoopName && (
				<span className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted-foreground lg:inline">
					feeds {feedsLoopName}
				</span>
			)}
			<span
				className={cn(
					'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold',
					isWorking ? 'text-success' : 'text-muted-foreground',
				)}
			>
				<span
					aria-hidden="true"
					className={cn(
						'size-1.5 shrink-0 rounded-full',
						isWorking ? 'animate-pulse bg-success' : 'bg-border-strong',
					)}
				/>
				{isWorking ? 'Working' : 'Idle'}
			</span>
		</Link>
	)
}
