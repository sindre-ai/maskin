import { ConversationSearchResults } from '@/components/chat/conversation-search-results'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useChatListSearch } from '@/hooks/use-chat-list-search'
import { useChatRowActions } from '@/hooks/use-chat-row-actions'
import { useReplyThreads } from '@/hooks/use-conversation'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import {
	type ChatListGroupBy,
	trackChatListSearchUsed,
	trackChatOpenedFromList,
} from '@/lib/analytics'
import type { ConversationListItemResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import {
	type ChatPill,
	groupChats,
	matchesPill,
	pillCounts,
	searchOperatorsUsed,
	trackedMarker,
} from '@/lib/chat-list-v2'
import { cn } from '@/lib/cn'
import { type LoadedList, activityTime } from '@/lib/conversation-search'
import { Link } from '@tanstack/react-router'
import { MessageCircle, MessageCircleWarning } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ChatPills } from './chat-pills'
import { ChatRow } from './chat-row'

/** Verbatim from the states addendum. */
export const EMPTY_COPY: Record<ChatPill, string> = {
	all: 'No chats yet. Start one with an agent.',
	needs_you: 'Nothing waits on you.',
	unread: 'You are all caught up.',
	working: 'No agent is working right now.',
	later: 'Nothing is on Later. Move a chat here to hide it until it gets a new message.',
}
export const EMPTY_SEARCH_COPY = 'No chats match. Try fewer words or remove an operator.'
export const LOAD_ERROR_COPY = 'Chats did not load.'

const SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e', 'f']
/** How long the search box holds still before the search counts as used. */
const SEARCH_SETTLE_MS = 1000

interface ChatListV2Props {
	workspaceId: string
	pill: ChatPill
	onPillChange: (next: ChatPill) => void
	groupBy: ChatListGroupBy
	/** Words in the search box. Operators in them are read by the server. */
	query: string
	className?: string
	/** Hide the "Start a new one" link, set beside the new chat screen. */
	hideStartLink?: boolean
}

/** Keeps fetching pages until the query holds everything, and stands down after a failed page. */
function useLoadAll(
	query: Pick<
		ReturnType<typeof useConversationsInfinite>,
		'hasNextPage' | 'isFetchingNextPage' | 'isFetchNextPageError' | 'fetchNextPage'
	>,
	enabled: boolean,
) {
	const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query
	useEffect(() => {
		if (enabled && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) fetchNextPage()
	}, [enabled, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])
}

export function ChatListV2({
	workspaceId,
	pill,
	onPillChange,
	groupBy,
	query,
	className,
	hideStartLink,
}: ChatListV2Props) {
	const viewerId = getStoredActor()?.id
	const actions = useChatRowActions(workspaceId)

	// The default list is the same two fetches as before: everything always listed in full (direct
	// messages, pinned, unread) streams in until done, and "recent" pages on scroll. Under a pill
	// the rest streams in too, so the pill's list is whole. Later chats are their own fetch: every
	// other list leaves them out.
	const priority = useConversationsInfinite(workspaceId, { scope: 'priority', hide_quiet: true })
	const recent = useConversationsInfinite(workspaceId, { scope: 'recent', hide_quiet: true })
	const laterQuery = useConversationsInfinite(workspaceId, { later: true })
	const wholeList = pill !== 'all'

	useLoadAll(priority, true)
	useLoadAll(laterQuery, true)
	useLoadAll(recent, wholeList)

	const fetched = useMemo(() => {
		const seen = new Set<string>()
		return [...(priority.data?.pages ?? []), ...(recent.data?.pages ?? [])]
			.flatMap((page) => page.conversations)
			.filter((c) => {
				if (c.archived || seen.has(c.id)) return false
				seen.add(c.id)
				return true
			})
	}, [priority.data, recent.data])
	// A server without the Later list answers with every chat; only a chat flagged later is one.
	const laterRows = useMemo(
		() =>
			(laterQuery.data?.pages ?? [])
				.flatMap((page) => page.conversations)
				.filter((c) => c.later && !c.archived),
		[laterQuery.data],
	)

	const isLoading =
		pill === 'later'
			? laterQuery.isLoading
			: priority.isLoading ||
				recent.isLoading ||
				(priority.hasNextPage && !priority.isFetchNextPageError) ||
				(wholeList && !!recent.hasNextPage && !recent.isFetchNextPageError)
	const isError = pill === 'later' ? laterQuery.isError : priority.isError || recent.isError
	const refetch = () => {
		if (pill === 'later') laterQuery.refetch()
		else {
			priority.refetch()
			recent.refetch()
		}
	}

	const counts = useMemo(() => {
		const all = [...fetched, ...laterRows]
		const c = pillCounts(all)
		c.later = laterRows.length
		return c
	}, [fetched, laterRows])
	const rows = useMemo(
		() => (pill === 'later' ? laterRows : fetched.filter((c) => matchesPill(c, pill))),
		[pill, fetched, laterRows],
	)
	const groups = useMemo(() => groupChats(rows, groupBy, { viewerId }), [rows, groupBy, viewerId])

	const { data: replyThreads } = useReplyThreads(workspaceId)
	const threadUnreadByChat = new Map<string, number>()
	for (const t of replyThreads?.threads ?? []) {
		threadUnreadByChat.set(
			t.conversationId,
			(threadUnreadByChat.get(t.conversationId) ?? 0) + t.thread.unreadCount,
		)
	}

	// Search: words leave the grouped list and ask the server for every chat the person is in.
	const needle = query.trim()
	const search = useChatListSearch(workspaceId, needle)
	const known = useMemo(
		() => new Map<string, ConversationListItemResponse>(fetched.map((c) => [c.id, c])),
		[fetched],
	)
	const loaded = useMemo<LoadedList | null>(() => {
		const recentRows = (recent.data?.pages ?? []).flatMap((page) => page.conversations)
		return {
			ids: new Set(fetched.map((c) => c.id)),
			hasMore: !!recent.hasNextPage || !!priority.hasNextPage || isLoading,
			oldestActivityAt: recentRows.length > 0 ? Math.min(...recentRows.map(activityTime)) : null,
		}
	}, [recent.data, recent.hasNextPage, priority.hasNextPage, fetched, isLoading])

	// Where each row on screen sits, for the "opened from the list" event.
	const placeById = new Map<
		string,
		{
			section: (typeof groups)[number]['section']
			position: number
			row: ConversationListItemResponse
		}
	>()
	for (const group of groups) {
		for (const c of group.items)
			placeById.set(c.id, { section: group.section, position: placeById.size + 1, row: c })
	}
	const trackOpened = (id: string) => {
		const place = placeById.get(id)
		if (!place) return
		trackChatOpenedFromList({
			source: 'list',
			section: place.section,
			position: place.position,
			marker: trackedMarker(place.row),
			filter: pill,
			group_by: groupBy,
		})
	}
	const trackSearchOpened = (position: number) =>
		trackChatOpenedFromList({
			source: 'search',
			section: 'search',
			position,
			filter: pill,
			group_by: groupBy,
		})

	// One event per search that has settled, with the operators it used and how many chats came back.
	const hitCountRef = useRef(0)
	hitCountRef.current = search.data?.results.length ?? 0
	const answered = !!search.data && !search.isFetching && !search.pending && !search.isError
	const settledQuery = needle !== '' && answered ? needle : ''
	useEffect(() => {
		if (!settledQuery) return
		const used = searchOperatorsUsed(settledQuery)
		const timer = setTimeout(
			() =>
				trackChatListSearchUsed({
					result_count: hitCountRef.current,
					operators: used.length > 0 ? used : ['none'],
				}),
			SEARCH_SETTLE_MS,
		)
		return () => clearTimeout(timer)
	}, [settledQuery])

	// Scrolling near the end of "recent" loads the next page (All only; a pill loads the rest itself).
	const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
	const scrollRef = useRef<HTMLDivElement | null>(null)
	const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = recent
	useEffect(() => {
		if (!sentinel || wholeList || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return
		if (typeof IntersectionObserver === 'undefined') return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) fetchNextPage()
			},
			{ root: scrollRef.current, rootMargin: '200px' },
		)
		observer.observe(sentinel)
		return () => observer.disconnect()
	}, [sentinel, wholeList, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])

	// Arrow keys move between rows; Enter opens the focused one (a link does that itself).
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
		const target = e.target as HTMLElement
		if (!target.matches('[data-chat-row-link]')) return
		const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-chat-row-link]'))
		const next = links[links.indexOf(target) + (e.key === 'ArrowDown' ? 1 : -1)]
		if (!next) return
		e.preventDefault()
		next.focus()
	}

	const searching = needle !== ''
	return (
		<div data-testid="chat-list-v2" className={cn('flex min-h-0 flex-1 flex-col', className)}>
			<ChatPills
				value={pill}
				onChange={onPillChange}
				counts={isLoading || isError ? null : counts}
			/>
			<div
				ref={scrollRef}
				onKeyDown={onKeyDown}
				className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 lg:pr-4 lg:pl-10"
			>
				{searching ? (
					<ConversationSearchResults
						workspaceId={workspaceId}
						query={needle}
						search={search}
						known={known}
						loaded={loaded}
						onOpen={trackSearchOpened}
						emptyTitle={EMPTY_SEARCH_COPY}
					/>
				) : isLoading ? (
					<div aria-busy="true" aria-label="Loading chats">
						{SKELETON_KEYS.map((key) => (
							<div
								key={key}
								className="flex gap-3 border-t border-border px-2 py-[11px] first:border-t-0"
							>
								<div className="size-8 shrink-0 animate-pulse-fast rounded-[30%] bg-muted" />
								<div className="min-w-0 flex-1 space-y-2">
									<div className="h-3.5 w-1/3 animate-pulse-fast rounded bg-muted" />
									<div className="h-3.5 w-2/3 animate-pulse-fast rounded bg-muted" />
									<div className="h-3 w-full animate-pulse-fast rounded bg-muted" />
								</div>
							</div>
						))}
					</div>
				) : isError ? (
					<EmptyState
						icon={<MessageCircleWarning size={24} aria-hidden="true" />}
						title={LOAD_ERROR_COPY}
						action={
							<Button variant="outline" size="sm" onClick={() => refetch()}>
								Retry
							</Button>
						}
					/>
				) : rows.length === 0 ? (
					<EmptyState
						icon={<MessageCircle size={24} aria-hidden="true" />}
						title={EMPTY_COPY[pill]}
						action={
							pill === 'all' && !hideStartLink ? (
								<Button asChild variant="link" size="sm">
									<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
										Start a new one →
									</Link>
								</Button>
							) : undefined
						}
					/>
				) : (
					<>
						{groups.map((group) => (
							<section
								key={group.key}
								aria-label={group.label || undefined}
								className="flex flex-col gap-px"
							>
								{group.label ? (
									<h2 className="px-2 pt-3.5 pb-2 text-[15px] font-semibold text-foreground">
										{group.label}
									</h2>
								) : null}
								{group.items.map((c) => (
									<ChatRow
										key={c.id}
										workspaceId={workspaceId}
										conversation={c}
										actions={actions}
										threadUnread={threadUnreadByChat.get(c.id) ?? 0}
										onOpen={() => trackOpened(c.id)}
									/>
								))}
							</section>
						))}
						{hasNextPage && !wholeList ? (
							<div
								ref={setSentinel}
								className="flex items-center justify-center gap-2 px-3 pt-4 pb-2.5 text-[11px] text-muted-foreground"
							>
								{isFetchingNextPage ? (
									<>
										<Spinner />
										Loading older chats…
									</>
								) : isFetchNextPageError ? (
									<>
										Couldn't load older chats.
										<Button variant="link" size="sm" onClick={() => fetchNextPage()}>
											Try again →
										</Button>
									</>
								) : null}
							</div>
						) : null}
					</>
				)}
			</div>
		</div>
	)
}
