import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { cn } from '@/lib/cn'
import { groupConversations } from '@/lib/conversation-groups'
import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import type { ChatsFilter } from './chats-filter-menu'
import { ConversationListRow } from './conversation-list-row'

interface ConversationListProps {
	workspaceId: string
	filter?: ChatsFilter
	className?: string
	/** True when the list owns the whole content width (no thread open) — the
	 *  rows then centre on a 900px column instead of stretching edge to edge. */
	expanded?: boolean
}

const EMPTY_COPY: Record<ChatsFilter, { title: string; description: string }> = {
	all: {
		title: 'No conversations here',
		description: 'Start a chat with a teammate or an agent.',
	},
	unread: {
		title: 'No conversations here',
		description: "Nothing is waiting on you — you've read everything.",
	},
	pinned: {
		title: 'No conversations here',
		description: 'Pin a chat from its header to keep it at the top of this list.',
	},
	archived: {
		title: 'Nothing archived yet',
		description: 'Archived chats stay searchable — they just leave the main list.',
	},
}

export function ConversationList({
	workspaceId,
	filter = 'all',
	className,
	expanded,
}: ConversationListProps) {
	// Omit `archived` unless it's the active filter — the backend already
	// defaults the list to non-archived conversations (see
	// `useConversationsInfinite`'s param-building note on why `archived: false`
	// must never be sent as a literal query string).
	const {
		data,
		isLoading,
		isError,
		refetch,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isFetchNextPageError,
	} = useConversationsInfinite(workspaceId, {
		...(filter === 'pinned' ? { pinned: true } : {}),
		...(filter === 'archived' ? { archived: true } : {}),
		...(filter === 'unread' ? { unread_only: true } : {}),
	})

	const conversations = data?.pages.flatMap((page) => page.conversations) ?? []
	const groups = groupConversations(conversations, {
		mode: filter === 'archived' ? 'archived' : 'default',
	})

	// Scroll-near-the-bottom auto-loads the next page (mockup 545–547) instead
	// of the old manual "Load older" button.
	const sentinelRef = useRef<HTMLDivElement | null>(null)
	const loadNextPage = useCallback(() => {
		fetchNextPage()
	}, [fetchNextPage])
	useEffect(() => {
		const el = sentinelRef.current
		// Stand down after a failed page: the sentinel is still on screen, so
		// re-observing would refire the same request in a tight loop. The manual
		// "Try again" below is the only way back in.
		if (!el || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return
		if (typeof IntersectionObserver === 'undefined') return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) loadNextPage()
			},
			{ rootMargin: '200px' },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [hasNextPage, isFetchingNextPage, isFetchNextPageError, loadNextPage])

	return (
		<div data-testid="conversation-list" className={cn('flex min-h-0 flex-1 flex-col', className)}>
			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
				<div className={cn('w-full', expanded && 'mx-auto max-w-[900px]')}>
					{isLoading ? (
						<div className="flex justify-center py-8">
							<Spinner />
						</div>
					) : isError ? (
						// A failed fetch must not borrow the empty state: "No conversations
						// here — start a chat" reads as an empty account and invites the
						// reader to duplicate a thread they already have.
						<EmptyState
							title="Couldn't load your conversations"
							description="Something went wrong reaching the server. Nothing has been lost — this is only the list."
							action={
								<Button variant="link" size="sm" onClick={() => refetch()}>
									Try again →
								</Button>
							}
						/>
					) : conversations.length === 0 ? (
						<EmptyState
							title={EMPTY_COPY[filter].title}
							description={EMPTY_COPY[filter].description}
							action={
								// Under a filter, "Start a new one" was a trap: the new chat
								// is unarchived/unpinned/read, so it lands outside the list
								// the reader is looking at. Clearing the filter is the only
								// action that shows anything.
								filter === 'all' ? (
									<Button asChild variant="link" size="sm">
										<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
											Start a new one →
										</Link>
									</Button>
								) : (
									<Button asChild variant="link" size="sm">
										<Link
											to="/$workspaceId/chats"
											params={{ workspaceId }}
											search={{ filter: undefined, wide: undefined }}
										>
											View all chats →
										</Link>
									</Button>
								)
							}
						/>
					) : (
						<>
							{groups.map((group) => (
								<div key={group.key} className="flex flex-col gap-px">
									<div className="eyebrow px-2 pt-2.5 pb-1">{group.label}</div>
									{group.items.map((c) => (
										<ConversationListRow key={c.id} workspaceId={workspaceId} conversation={c} />
									))}
								</div>
							))}
							{/* Nothing marks the end of the list. The mockup's
							    "that's the whole history — N conversations" footer was
							    a running total nobody asked for, printed under every
							    short list; the last row ending is signal enough. */}
							{hasNextPage ? (
								// The sentinel is the loader; its label only claims to be
								// loading while a page is actually in flight (mockup 545–549).
								<div
									ref={sentinelRef}
									className="flex items-center justify-center gap-2 px-3 pt-4 pb-2.5 text-[11px] text-muted-foreground"
								>
									{isFetchingNextPage ? (
										<>
											<Spinner />
											Loading older conversations…
										</>
									) : isFetchNextPageError ? (
										// Without this the sentinel sits there promising a load
										// that already failed, and scrolling never retries it.
										<>
											Couldn't load older conversations.
											<Button variant="link" size="sm" onClick={loadNextPage}>
												Try again →
											</Button>
										</>
									) : (
										'Older conversations load as you scroll'
									)}
								</div>
							) : null}
						</>
					)}
				</div>
			</div>
		</div>
	)
}
