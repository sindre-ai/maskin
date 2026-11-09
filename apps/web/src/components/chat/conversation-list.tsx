import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useReplyThreads } from '@/hooks/use-conversation'
import { useConversationsInfinite, useUpdateConversationMe } from '@/hooks/use-conversations'
import { type ConversationListItemResponse, api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { groupConversations } from '@/lib/conversation-groups'
import { focusField, usePageSearchShortcut } from '@/lib/page-search-shortcut'
import { Link } from '@tanstack/react-router'
import { ChevronDown, MessageCircle, MessageCircleWarning, Plus, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { type ChatsFilter, ChatsFilterMenu } from './chats-filter-menu'
import { ConversationListRow } from './conversation-list-row'
import { ReplyThreadList } from './replies/reply-thread-list'

/**
 * The list column's head (v3): the 34px "Chats" title, then a search pill that is
 * a round icon until it is focused or holds text (it then takes the whole row and
 * the title and buttons step aside), the filter icon and the black New chat
 * button. Below md the shared nav row still carries the title and New chat, so
 * the head keeps the plain search field and filter pill there.
 */
export function ConversationListHeader({
	filter,
	onFilterChange,
	query,
	onQueryChange,
	workspaceId,
	titled,
	pageTitle = true,
}: {
	filter: ChatsFilter
	onFilterChange: (next: ChatsFilter) => void
	query: string
	onQueryChange: (next: string) => void
	workspaceId: string
	/** Draw the title and New chat here (desktop); false leaves them to the nav row. */
	titled: boolean
	/** The list's title is the page's `h1`. False on the new-chat screen, where the nav row
	 *  keeps "New chat" as the `h1`. */
	pageTitle?: boolean
}) {
	const searchRef = useRef<HTMLInputElement>(null)
	const [focused, setFocused] = useState(false)
	usePageSearchShortcut(() => focusField(searchRef.current))
	const expanded = focused || query !== ''
	if (!titled) {
		return (
			<div className="flex flex-none flex-col gap-3 px-4 pt-3 pb-3 lg:pl-7">
				<div className="flex flex-col items-start gap-2">
					<label className="flex h-[34px] w-full min-w-0 items-center gap-2 rounded-full bg-secondary max-md:min-h-11 pointer-coarse:min-h-11 px-3 text-muted-foreground">
						<Search size={14} aria-hidden className="shrink-0" />
						<input
							ref={searchRef}
							type="search"
							value={query}
							onChange={(e) => onQueryChange(e.target.value)}
							placeholder="Search chats"
							aria-label="Search chats"
							className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</label>
					<ChatsFilterMenu value={filter} onChange={onFilterChange} />
				</div>
			</div>
		)
	}
	const Heading = pageTitle ? 'h1' : 'h2'
	return (
		<div className="flex flex-none items-center gap-2 pr-5 pb-4 pl-7">
			{/* Always in the DOM so the page keeps its heading; while the search is open it is only
			    visually hidden. */}
			<Heading
				className={cn('page-title min-w-0 flex-1 truncate', expanded && 'sr-only flex-none')}
			>
				Chats
			</Heading>
			<label
				className={cn(
					'flex h-8 min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-full bg-background px-[9px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-[flex] duration-300',
					expanded ? 'flex-1 cursor-text' : 'w-8 flex-none',
				)}
			>
				<Search size={14} aria-hidden className="shrink-0" />
				<input
					ref={searchRef}
					type="search"
					value={query}
					onChange={(e) => onQueryChange(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					placeholder="Search chats"
					aria-label="Search chats"
					className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
			</label>
			<div className={cn('flex flex-none items-center gap-2', expanded && 'hidden')}>
				<ChatsFilterMenu value={filter} onChange={onFilterChange} iconOnly />
				<Button
					asChild
					size="icon"
					className="size-8 rounded-full"
					aria-label="New chat"
					title="New chat"
				>
					<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
						<Plus size={14} strokeWidth={2.6} aria-hidden />
					</Link>
				</Button>
			</div>
		</div>
	)
}

interface ConversationListProps {
	workspaceId: string
	filter?: ChatsFilter
	/** Narrows the loaded chats by title, preview or participant name. */
	query?: string
	className?: string
	/** True when the list owns the whole content width (no thread open) — the
	 *  rows then centre on a 900px column instead of stretching edge to edge. */
	expanded?: boolean
	/** Hide the "Start a new one" link in the empty state — set beside the new
	 *  chat screen, where the link would point at the page the reader is on. */
	hideStartLink?: boolean
}

const EMPTY_COPY: Record<ChatsFilter, { title: string; description: string }> = {
	all: {
		title: 'No chats yet',
		description: 'Start one with the Chief of Staff.',
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
	// Threads has its own list (`ReplyThreadList`); this entry only satisfies the record.
	threads: { title: 'No threads yet', description: 'Reply to a message to start one.' },
}

export function ConversationList(props: ConversationListProps) {
	// Threads are not conversations: they list from another endpoint, so they get their own list.
	// Split here, above the hooks, so the hook order never changes within one mounted list.
	if (props.filter === 'threads') {
		return (
			<ReplyThreadList
				workspaceId={props.workspaceId}
				className={props.className}
				expanded={props.expanded}
			/>
		)
	}
	return <ChatConversationList {...props} />
}

function ChatConversationList({
	workspaceId,
	filter = 'all',
	query,
	className,
	expanded,
	hideStartLink,
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

	const fetched = useMemo(() => data?.pages.flatMap((page) => page.conversations) ?? [], [data])
	// Reading a chat opened from the Unread filter would drop its row on the
	// next refetch and shift everything below it. Keep rows that were shown in
	// place (as read) until the filter or workspace changes.
	const shownRef = useRef<{ key: string; rows: ConversationListItemResponse[] }>({
		key: '',
		rows: [],
	})
	const conversations = useMemo(() => {
		if (filter !== 'unread') {
			// Forget retained rows so coming back to Unread starts from the server's list.
			shownRef.current = { key: '', rows: [] }
			return fetched
		}
		const key = `${workspaceId}:${filter}`
		const prev = shownRef.current.key === key ? shownRef.current.rows : []
		// Server order wins. A retained row the server no longer returns goes back
		// right after the row that was above it, so a later page never lands on top.
		const rows = [...fetched]
		const ids = new Set(rows.map((c) => c.id))
		prev.forEach((c, i) => {
			if (ids.has(c.id)) return
			let at = 0
			for (let j = i - 1; j >= 0; j--) {
				const above = rows.findIndex((r) => r.id === prev[j].id)
				if (above !== -1) {
					at = above + 1
					break
				}
			}
			rows.splice(at, 0, { ...c, unread_count: 0 })
			ids.add(c.id)
		})
		const visible = rows.filter((c) => !c.archived)
		shownRef.current = { key, rows: visible }
		return visible
	}, [fetched, filter, workspaceId])
	// Unread thread replies per chat, from the same list the Threads filter shows. A chat that
	// reads as caught up can still hold an unread thread; the row says so.
	const { data: replyThreads } = useReplyThreads(workspaceId)
	const threadUnreadByChat = new Map<string, number>()
	for (const t of replyThreads?.threads ?? []) {
		threadUnreadByChat.set(
			t.conversationId,
			(threadUnreadByChat.get(t.conversationId) ?? 0) + t.thread.unreadCount,
		)
	}
	const needle = (query ?? '').trim().toLowerCase()
	const shown = needle
		? conversations.filter((c) =>
				[c.title, c.snippet ?? '', ...c.participants.map((p) => p.actorName)]
					.join(' ')
					.toLowerCase()
					.includes(needle),
			)
		: conversations
	const groups = groupConversations(shown, {
		mode: filter === 'archived' ? 'archived' : 'unread',
	})
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
	const updateMe = useUpdateConversationMe(workspaceId)
	const markAllRead = async () => {
		// Exactly the chats the Unread group lists (pinned chats sit in their own group).
		const unread = groups.find((g) => g.key === 'unread')?.items ?? []
		// The list carries no newest-message id, so read each unread chat's newest one.
		// One failing chat must not undo or hide the others, so settle them all.
		const results = await Promise.allSettled(
			unread.map(async (c) => {
				const res = await api.conversations.messages(c.id, workspaceId)
				const newest = Math.max(0, ...res.messages.map((m) => m.id))
				if (newest > 0)
					await updateMe.mutateAsync({ id: c.id, data: { last_read_message_id: newest } })
			}),
		)
		const failed = results.filter((r) => r.status === 'rejected').length
		if (failed > 0) {
			toast.error(
				failed === 1
					? "Couldn't mark 1 chat as read. The rest are done."
					: `Couldn't mark ${failed} chats as read. The rest are done.`,
			)
		}
	}

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
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 lg:pr-4 lg:pl-10">
				<div className={cn('w-full', expanded && 'mx-auto max-w-[900px]')}>
					{isLoading ? (
						<ListSkeleton rows={8} />
					) : isError ? (
						// A failed fetch must not borrow the empty state: "No conversations
						// here — start a chat" reads as an empty account and invites the
						// reader to duplicate a thread they already have.
						<EmptyState
							icon={<MessageCircleWarning size={24} aria-hidden="true" />}
							title="Couldn't load chats"
							description="Check your connection and try again."
							action={
								<Button variant="outline" size="sm" onClick={() => refetch()}>
									Try again
								</Button>
							}
						/>
					) : conversations.length === 0 ? (
						<EmptyState
							icon={<MessageCircle size={24} aria-hidden="true" />}
							title={EMPTY_COPY[filter].title}
							description={EMPTY_COPY[filter].description}
							action={
								// Under a filter, "Start a new one" was a trap: the new chat
								// is unarchived/unpinned/read, so it lands outside the list
								// the reader is looking at. Clearing the filter is the only
								// action that shows anything.
								filter === 'all' ? (
									hideStartLink ? undefined : (
										<Button asChild variant="link" size="sm">
											<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
												Start a new one →
											</Link>
										</Button>
									)
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
									<div className="flex items-center gap-2 px-2 pt-3.5 pb-3 text-[15px]">
										<button
											type="button"
											aria-expanded={!collapsed.has(group.key)}
											onClick={() =>
												setCollapsed((prev) => {
													const next = new Set(prev)
													if (!next.delete(group.key)) next.add(group.key)
													return next
												})
											}
											className="flex items-center gap-2 rounded-md font-semibold text-foreground"
										>
											<ChevronDown
												size={14}
												aria-hidden
												className={cn(
													'text-muted-foreground transition-transform',
													collapsed.has(group.key) && '-rotate-90',
												)}
											/>
											<span>{group.label}</span>
											<span className="font-medium text-muted-foreground">
												{group.items.length}
											</span>
										</button>
										{group.key === 'unread' ? (
											<button
												type="button"
												onClick={markAllRead}
												className="ml-auto text-[12.5px] font-semibold text-muted-foreground hover:text-foreground"
											>
												Mark all read
											</button>
										) : null}
									</div>
									{(collapsed.has(group.key) ? [] : group.items).map((c) => (
										<ConversationListRow
											key={c.id}
											workspaceId={workspaceId}
											conversation={c}
											threadUnread={threadUnreadByChat.get(c.id) ?? 0}
										/>
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
							) : (
								<div className="flex items-center justify-center px-3 pt-4 pb-2.5 text-center text-[11px] text-muted-foreground">
									That's the whole history — {conversations.length} in this workspace.
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	)
}
