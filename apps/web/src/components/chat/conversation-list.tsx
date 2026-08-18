import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { cn } from '@/lib/cn'
import { groupConversations } from '@/lib/conversation-groups'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
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
	const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useConversationsInfinite(workspaceId, {
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
	useEffect(() => {
		const el = sentinelRef.current
		if (!el || !hasNextPage || isFetchingNextPage) return
		if (typeof IntersectionObserver === 'undefined') return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) fetchNextPage()
			},
			{ rootMargin: '200px' },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [hasNextPage, isFetchingNextPage, fetchNextPage])

	return (
		<div data-testid="conversation-list" className={cn('flex min-h-0 flex-1 flex-col', className)}>
			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
				<div className={cn('w-full', expanded && 'mx-auto max-w-[900px]')}>
					{isLoading ? (
						<div className="flex justify-center py-8">
							<Spinner />
						</div>
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
									) : (
										'Older conversations load as you scroll'
									)}
								</div>
							) : (
								<div className="px-3 pt-3 text-center text-[10.5px] text-muted-foreground">
									That's the whole history — {conversations.length}{' '}
									{conversations.length === 1 ? 'conversation' : 'conversations'} in this workspace.
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	)
}
