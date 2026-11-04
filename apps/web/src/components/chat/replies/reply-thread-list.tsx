import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useReplyThreads } from '@/hooks/use-conversation'
import type { ReplyThreadListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

/** Threads the viewer is in, newest activity first, each opening its thread in its chat. */
export function ReplyThreadList({
	workspaceId,
	className,
	expanded,
}: {
	workspaceId: string
	className?: string
	expanded?: boolean
}) {
	const { data, isLoading, isError, refetch } = useReplyThreads(workspaceId)
	const threads = data?.threads ?? []

	return (
		<div data-testid="reply-thread-list" className={cn('flex min-h-0 flex-1 flex-col', className)}>
			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
				<div className={cn('w-full', expanded && 'mx-auto max-w-[900px]')}>
					{isLoading ? (
						<div className="flex justify-center py-8">
							<Spinner />
						</div>
					) : isError ? (
						<EmptyState
							title="Couldn't load your threads"
							description="Something went wrong reaching the server. Nothing has been lost — this is only the list."
							action={
								<Button variant="link" size="sm" onClick={() => refetch()}>
									Try again →
								</Button>
							}
						/>
					) : threads.length === 0 ? (
						<EmptyState
							title="No threads yet"
							description="Reply to a message in a chat to start one. Threads you are in show up here."
						/>
					) : (
						<div className="flex flex-col gap-px pt-1">
							{threads.map((t) => (
								<ReplyThreadRow
									key={`${t.conversationId}-${t.root.id}`}
									workspaceId={workspaceId}
									item={t}
								/>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

function ReplyThreadRow({ workspaceId, item }: { workspaceId: string; item: ReplyThreadListItem }) {
	const { thread, root, lastReply } = item
	const isUnread = thread.unreadCount > 0
	const preview = lastReply ?? root
	const replies = `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}`
	return (
		<Link
			to="/$workspaceId/chats/$conversationId"
			params={{ workspaceId, conversationId: item.conversationId }}
			search={{ thread: root.id }}
			className="flex flex-col gap-0.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-accent"
		>
			<div className="flex items-center gap-1.5">
				{isUnread ? (
					<span
						aria-label={`${thread.unreadCount} unread`}
						className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
					/>
				) : null}
				<span
					className={cn(
						'min-w-0 flex-1 truncate text-[12.5px] tracking-[-0.01em] text-foreground',
						isUnread ? 'font-bold' : 'font-medium',
					)}
				>
					{item.conversationTitle}
				</span>
				<RelativeTime
					date={thread.lastReplyAt ?? root.createdAt}
					format="clock"
					className="shrink-0 text-[10px] text-muted-foreground"
				/>
			</div>
			<span className="line-clamp-1 text-[11.5px] leading-[1.4] text-muted-foreground">
				<span className="font-medium">{root.actorName}: </span>
				{root.content}
			</span>
			<span className="line-clamp-1 text-[11.5px] leading-[1.4] text-muted-foreground">
				{replies}
				{preview !== root ? ` · ${preview.actorName}: ${preview.content}` : ''}
			</span>
		</Link>
	)
}
