import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { ConversationListRow } from './conversation-list-row'

interface ConversationListProps {
	workspaceId: string
	className?: string
}

export function ConversationList({ workspaceId, className }: ConversationListProps) {
	// Omit `archived` — the backend already defaults the list to non-archived
	// conversations (see `useConversationsInfinite`'s param-building note on
	// why `archived: false` must never be sent as a literal query string).
	const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useConversationsInfinite(workspaceId)

	const conversations = data?.pages.flatMap((page) => page.conversations) ?? []
	const pinned = conversations.filter((c) => c.pinned)
	const rest = conversations.filter((c) => !c.pinned)

	return (
		<div className={cn('flex min-h-0 flex-1 flex-col', className)}>
			<div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
				<h2 className="text-sm font-semibold">Chats</h2>
				<Button asChild size="icon" variant="ghost" className="h-7 w-7" aria-label="New chat">
					<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
						<Plus size={15} />
					</Link>
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{isLoading ? (
					<div className="flex justify-center py-8">
						<Spinner />
					</div>
				) : conversations.length === 0 ? (
					<EmptyState
						title="No conversations yet"
						description="Start a chat with a teammate or an agent."
						action={
							<Button asChild size="sm">
								<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
									New chat
								</Link>
							</Button>
						}
					/>
				) : (
					<div className="flex flex-col gap-2">
						{pinned.length > 0 ? (
							<div className="flex flex-col gap-0.5">
								<div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Pinned
								</div>
								{pinned.map((c) => (
									<ConversationListRow key={c.id} workspaceId={workspaceId} conversation={c} />
								))}
							</div>
						) : null}
						<div className="flex flex-col gap-0.5">
							{rest.map((c) => (
								<ConversationListRow key={c.id} workspaceId={workspaceId} conversation={c} />
							))}
						</div>
						{hasNextPage ? (
							<div className="flex justify-center py-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => fetchNextPage()}
									disabled={isFetchingNextPage}
								>
									{isFetchingNextPage ? <Spinner /> : 'Load older'}
								</Button>
							</div>
						) : null}
					</div>
				)}
			</div>
		</div>
	)
}
