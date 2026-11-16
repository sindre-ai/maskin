import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useChatListSearch } from '@/hooks/use-chat-list-search'
import {
	useChatSections,
	useCreateChatSection,
	useDeleteChatSection,
	useMoveChatToSection,
	useReorderChatSections,
	useUpdateChatSection,
} from '@/hooks/use-chat-sections'
import { useReplyThreads } from '@/hooks/use-conversation'
import { useConversationsInfinite, useUpdateConversationMe } from '@/hooks/use-conversations'
import {
	type ChatListSection,
	trackChatListSearchUsed,
	trackChatOpenedFromList,
} from '@/lib/analytics'
import { type ChatSectionResponse, type ConversationListItemResponse, api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import {
	type ChatListViewName,
	groupWithSections,
	sectionIdOfGroup,
	viewReason,
	waitingCount,
} from '@/lib/chat-list-sections'
import { type ChatListView, DEFAULT_CHAT_LIST_VIEW } from '@/lib/chat-list-view'
import { cn } from '@/lib/cn'
import { activityMs, groupConversations } from '@/lib/conversation-groups'
import { type LoadedList, activityTime } from '@/lib/conversation-search'
import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	MouseSensor,
	TouchSensor,
	useDraggable,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { Link } from '@tanstack/react-router'
import { ChevronDown, MessageCircle, MessageCircleWarning, Plus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ChatsFilter } from '../chats-filter-menu'
import { ConversationAgentRow } from '../conversation-agent-row'
import { ConversationListRow } from '../conversation-list-row'
import { ConversationSearchResults } from '../conversation-search-results'
import {
	ChatSectionGroup,
	LIST_DROP_PREFIX,
	ListDropZone,
	SECTION_DROP_PREFIX,
} from './chat-section-group'
import { ChatViewTiles } from './chat-view-tiles'
import { MoveToSectionMenu } from './move-to-section-menu'
import { QuietFooter, QuietNote, hasSeenQuietNote, markQuietNoteSeen } from './quiet-note'
import { SectionNameForm } from './section-name-form'

const SEARCH_SETTLE_MS = 1000

/** The filter each automatic view lives under in the address bar. */
const VIEW_FILTER: Record<ChatListViewName, ChatsFilter> = {
	waiting: 'unread',
	running: 'running',
	quiet: 'quiet',
}

function viewOfFilter(filter: ChatsFilter): ChatListViewName | null {
	if (filter === 'unread') return 'waiting'
	if (filter === 'running' || filter === 'quiet') return filter
	return null
}

const VIEW_COPY: Record<
	ChatListViewName,
	{ title: string; intro: string; emptyTitle: string; emptyBody: string }
> = {
	waiting: {
		title: 'Waiting on you',
		intro: 'Mentions and open cards, newest first.',
		emptyTitle: 'Nothing is waiting on you',
		emptyBody: 'Mentions and open cards from agents show up here.',
	},
	running: {
		title: 'Running',
		intro: 'Chats where an agent is working now.',
		emptyTitle: 'No agent is running',
		emptyBody: 'Chats with an agent at work show up here.',
	},
	quiet: {
		title: 'Quiet',
		intro:
			'No message for 7 days. A new message brings a chat back to your list. Pin it or put it in a section to keep it.',
		emptyTitle: 'Nothing is quiet',
		emptyBody: 'Chats with no message for 7 days show up here.',
	},
}

const EMPTY_COPY: Partial<Record<ChatsFilter, { title: string; description: string }>> = {
	all: { title: 'No chats yet', description: 'Start one with the Chief of Staff.' },
	pinned: {
		title: 'No conversations here',
		description: 'Pin a chat from its header to keep it at the top of this list.',
	},
	archived: {
		title: 'Nothing archived yet',
		description: 'Archived chats stay searchable — they just leave the main list.',
	},
}

/** The place a row reads as in the "opened from the list" event. The section name never leaves. */
function sectionOfGroup(groupKey: string): ChatListSection {
	if (sectionIdOfGroup(groupKey)) return 'custom'
	if (groupKey === 'rooms') return 'room'
	if (groupKey === 'pinned') return 'pinned'
	if (groupKey === 'agents') return 'agent'
	return 'recent'
}

function DraggableRow({ id, children }: { id: string; children: ReactNode }) {
	// Only the pointer listeners: the wrapper must not become a second tab stop around the row's
	// link. The keyboard route is Move to section in the row's menu.
	const { setNodeRef, listeners, isDragging } = useDraggable({ id })
	return (
		<div ref={setNodeRef} {...listeners} className={cn(isDragging && 'opacity-40')}>
			{children}
		</div>
	)
}

interface SectionedChatListProps {
	workspaceId: string
	filter?: ChatsFilter
	query?: string
	className?: string
	expanded?: boolean
	hideStartLink?: boolean
	view?: ChatListView
	/** Tiles and "Back to all chats" move the list between filters. */
	onFilterChange: (next: ChatsFilter) => void
}

export function SectionedChatList({
	workspaceId,
	filter = 'all',
	query,
	className,
	expanded,
	hideStartLink,
	view = DEFAULT_CHAT_LIST_VIEW,
	onFilterChange,
}: SectionedChatListProps) {
	const selfId = getStoredActor()?.id
	const activeView = viewOfFilter(filter)
	const scoped = filter === 'all'
	const needle = (query ?? '').trim()
	const searching = needle !== ''
	const tilesShown = !searching && (scoped || activeView !== null)

	const sectionsQuery = useChatSections(workspaceId)
	const sections = useMemo<ChatSectionResponse[]>(
		() => sectionsQuery.data?.sections ?? [],
		[sectionsQuery.data],
	)
	const sectionOfChat = useMemo(() => {
		const map = new Map<string, string>()
		for (const s of sections)
			for (const id of s.conversationIds) if (!map.has(id)) map.set(id, s.id)
		return map
	}, [sections])
	const sectionName = useMemo(() => new Map(sections.map((s) => [s.id, s.name])), [sections])

	// The default list is two fetches so every group's number and order is right on arrival.
	const single = useConversationsInfinite(
		workspaceId,
		{
			...(filter === 'pinned' ? { pinned: true } : {}),
			...(filter === 'archived' ? { archived: true } : {}),
		},
		{ enabled: !scoped && activeView === null },
	)
	const priority = useConversationsInfinite(
		workspaceId,
		{ scope: 'priority', hide_quiet: true },
		{ enabled: scoped },
	)
	const recent = useConversationsInfinite(
		workspaceId,
		{ scope: 'recent', hide_quiet: true },
		{ enabled: scoped },
	)
	// Each view is a list of its own; its tile reads the same query, so opening it costs nothing more.
	const waitingQ = useConversationsInfinite(
		workspaceId,
		{ view: 'waiting' },
		{ enabled: tilesShown },
	)
	const runningQ = useConversationsInfinite(
		workspaceId,
		{ view: 'running' },
		{ enabled: tilesShown },
	)
	const quietQ = useConversationsInfinite(workspaceId, { view: 'quiet' }, { enabled: tilesShown })
	const viewQueries = { waiting: waitingQ, running: runningQ, quiet: quietQ }

	const active = activeView ? viewQueries[activeView] : scoped ? recent : single
	const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = active

	const {
		hasNextPage: priorityHasMore,
		isFetchingNextPage: priorityFetching,
		isFetchNextPageError: priorityFailed,
		fetchNextPage: fetchMorePriority,
	} = priority
	useEffect(() => {
		if (scoped && priorityHasMore && !priorityFetching && !priorityFailed) fetchMorePriority()
	}, [scoped, priorityHasMore, priorityFetching, priorityFailed, fetchMorePriority])

	const isLoading = activeView
		? active.isLoading
		: scoped
			? priority.isLoading ||
				recent.isLoading ||
				(priorityHasMore && !priorityFailed) ||
				sectionsQuery.isLoading
			: single.isLoading || sectionsQuery.isLoading
	const isError = activeView
		? active.isError
		: scoped
			? priority.isError || recent.isError || priorityFailed
			: single.isError
	const refetch = () => {
		if (activeView) active.refetch()
		else if (scoped) {
			priority.refetch()
			recent.refetch()
		} else single.refetch()
	}

	const priorityData = priority.data
	const recentData = recent.data
	const singleData = single.data
	const activeData = active.data
	// Pages are fetched by offset, so a chat bumped while the list is open can come back on the next
	// page. Keep the first copy of each chat.
	const fetched = useMemo(() => {
		const pages = activeView
			? (activeData?.pages ?? [])
			: scoped
				? [...(priorityData?.pages ?? []), ...(recentData?.pages ?? [])]
				: (singleData?.pages ?? [])
		const seen = new Set<string>()
		return pages
			.flatMap((page) => page.conversations)
			.filter((c) => {
				if (seen.has(c.id)) return false
				seen.add(c.id)
				return true
			})
	}, [activeView, scoped, activeData, priorityData, recentData, singleData])

	const rowsOf = (q: typeof waitingQ) => (q.data?.pages ?? []).flatMap((p) => p.conversations)
	const counts = {
		waiting: {
			count: waitingQ.isSuccess ? rowsOf(waitingQ).reduce((n, c) => n + waitingCount(c), 0) : null,
			more: !!waitingQ.hasNextPage,
		},
		running: {
			count: runningQ.isSuccess ? rowsOf(runningQ).length : null,
			more: !!runningQ.hasNextPage,
		},
		quiet: {
			count: quietQ.isSuccess ? rowsOf(quietQ).length : null,
			more: !!quietQ.hasNextPage,
		},
	}
	const quietCount = counts.quiet.count ?? 0

	const { data: replyThreads } = useReplyThreads(workspaceId)
	const threadUnreadByChat = new Map<string, number>()
	for (const t of replyThreads?.threads ?? []) {
		threadUnreadByChat.set(
			t.conversationId,
			(threadUnreadByChat.get(t.conversationId) ?? 0) + t.thread.unreadCount,
		)
	}

	const search = useChatListSearch(workspaceId, needle)
	const known = useMemo(() => new Map(fetched.map((c) => [c.id, c])), [fetched])
	const loaded = useMemo<LoadedList | null>(() => {
		if (!scoped) return null
		const rows = (recentData?.pages ?? []).flatMap((page) => page.conversations)
		return {
			ids: new Set(fetched.map((c) => c.id)),
			hasMore: !!hasNextPage || priorityHasMore || isLoading,
			oldestActivityAt: rows.length > 0 ? Math.min(...rows.map(activityTime)) : null,
		}
	}, [scoped, recentData, fetched, hasNextPage, priorityHasMore, isLoading])

	// What the list draws: a view is one flat newest-first list; the rest is grouped.
	const viewRows = useMemo(
		() => (activeView ? [...fetched].sort((a, b) => activityMs(b) - activityMs(a)) : []),
		[activeView, fetched],
	)
	const groups = useMemo(() => {
		if (activeView) return []
		if (filter === 'archived') return groupConversations(fetched, { mode: 'archived' })
		if (filter === 'pinned') return groupConversations(fetched, { mode: 'recent' })
		return groupWithSections(fetched, sections, selfId, new Date(), view)
	}, [activeView, filter, fetched, sections, selfId, view])

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
	const isCollapsed = (key: string) => {
		const id = sectionIdOfGroup(key)
		return id ? (sections.find((s) => s.id === id)?.collapsed ?? false) : collapsed.has(key)
	}

	// Where each row on screen sits, for the "opened from the list" event.
	const placeById = new Map<string, { section: ChatListSection; position: number }>()
	let position = 0
	if (activeView) {
		for (const c of viewRows) {
			position += 1
			placeById.set(c.id, { section: activeView, position })
		}
	} else {
		for (const group of groups) {
			if (isCollapsed(group.key)) continue
			const section = sectionOfGroup(group.key)
			if (group.entries) {
				for (const entry of group.entries) {
					position += 1
					const chats = entry.kind === 'agent' ? entry.conversations : [entry.conversation]
					for (const c of chats) placeById.set(c.id, { section, position })
				}
				continue
			}
			for (const c of group.items) {
				position += 1
				placeById.set(c.id, { section, position })
			}
		}
	}
	const trackOpened = (id: string) => {
		const place = placeById.get(id)
		if (place) trackChatOpenedFromList({ source: 'list', ...place })
	}
	const trackSearchOpened = (pos: number) =>
		trackChatOpenedFromList({ source: 'search', section: 'search', position: pos })

	const hitCountRef = useRef(0)
	hitCountRef.current = search.data?.results.length ?? 0
	const answered = !!search.data && !search.isFetching && !search.pending && !search.isError
	const settledQuery = searching && answered ? needle : ''
	useEffect(() => {
		if (!settledQuery) return
		const timer = setTimeout(
			() => trackChatListSearchUsed({ result_count: hitCountRef.current }),
			SEARCH_SETTLE_MS,
		)
		return () => clearTimeout(timer)
	}, [settledQuery])

	// Section changes ----------------------------------------------------------------------
	const createSection = useCreateChatSection(workspaceId)
	const updateSection = useUpdateChatSection(workspaceId)
	const deleteSection = useDeleteChatSection(workspaceId)
	const reorderSections = useReorderChatSections(workspaceId)
	const moveChat = useMoveChatToSection(workspaceId)
	const [creating, setCreating] = useState<{ conversationId?: string } | null>(null)
	const [renamingId, setRenamingId] = useState<string | null>(null)

	const move = useCallback(
		(c: Pick<ConversationListItemResponse, 'id'>, target: string | null) => {
			const from = sectionOfChat.get(c.id) ?? null
			if (from === target) return
			moveChat.mutate(
				{ conversationId: c.id, sectionId: target, fromSectionId: from },
				{ onError: () => toast.error("Couldn't move the chat. Try again.") },
			)
			toast(
				target ? `Moved to ${sectionName.get(target) ?? 'the section'}.` : 'Back in your list.',
				{
					action: {
						label: 'Undo',
						onClick: () =>
							moveChat.mutate({ conversationId: c.id, sectionId: from, fromSectionId: target }),
					},
				},
			)
		},
		[moveChat, sectionOfChat, sectionName],
	)

	const addSection = async (name: string) => {
		const intoChat = creating?.conversationId
		const section = await createSection.mutateAsync({ name })
		if (intoChat) {
			await moveChat.mutateAsync({ conversationId: intoChat, sectionId: section.id })
			toast(`Added ${name} and moved the chat in.`)
		} else {
			toast(`Added ${name}. Drag chats in, or use More on a chat.`)
		}
		setCreating(null)
	}

	const shiftSection = (id: string, direction: -1 | 1) => {
		const ids = [...sections].sort((a, b) => a.position - b.position).map((s) => s.id)
		const at = ids.indexOf(id)
		const to = at + direction
		if (at < 0 || to < 0 || to >= ids.length) return
		;[ids[at], ids[to]] = [ids[to], ids[at]]
		reorderSections.mutate(ids, { onError: () => toast.error("Couldn't reorder the sections.") })
	}

	const removeSection = (section: ChatSectionResponse) => {
		const n = section.conversationIds.length
		deleteSection.mutate(section.id, {
			onError: () => toast.error("Couldn't delete the section. Try again."),
		})
		toast(`Deleted ${section.name}. ${n} ${n === 1 ? 'chat is' : 'chats are'} back in your list.`, {
			action: {
				label: 'Undo',
				onClick: async () => {
					try {
						// The section comes back at the end with the same chats in it.
						const back = await createSection.mutateAsync({ name: section.name })
						for (const id of section.conversationIds) {
							await api.chatSections.addChat(back.id, id, workspaceId)
						}
						await sectionsQuery.refetch()
					} catch {
						toast.error("Couldn't undo. Add the section again.")
					}
				},
			},
		})
	}

	const moveMenu = (c: ConversationListItemResponse) => (
		<MoveToSectionMenu
			sections={sections}
			currentSectionId={sectionOfChat.get(c.id) ?? null}
			onMove={(target) => move(c, target)}
			onNewSection={() => setCreating({ conversationId: c.id })}
		/>
	)

	// Drag and drop --------------------------------------------------------------------------
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
	)
	const [dragging, setDragging] = useState<ConversationListItemResponse | null>(null)
	const onDragEnd = (event: DragEndEvent) => {
		setDragging(null)
		const over = event.over?.id
		if (typeof over !== 'string') return
		const chat = known.get(String(event.active.id))
		if (!chat) return
		if (over.startsWith(SECTION_DROP_PREFIX)) move(chat, over.slice(SECTION_DROP_PREFIX.length))
		else if (over.startsWith(LIST_DROP_PREFIX)) move(chat, null)
	}

	// Waiting on you: mark mentions read. Open cards stay until answered.
	const updateMe = useUpdateConversationMe(workspaceId)
	const markMentionsRead = async () => {
		const withMentions = viewRows.filter((c) => (c.mentions_unread ?? 0) > 0)
		const results = await Promise.allSettled(
			withMentions.map(async (c) => {
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

	// The note on the first view after release, then the footer line for good.
	const [noteSeen, setNoteSeen] = useState(() => hasSeenQuietNote(selfId))
	const dismissNote = () => {
		markQuietNoteSeen(selfId)
		setNoteSeen(true)
	}
	const showQuietNote = scoped && !searching && !noteSeen && quietCount > 0

	// Auto-load the next page near the bottom --------------------------------------------------
	const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
	const scrollRef = useRef<HTMLDivElement | null>(null)
	const loadNextPage = useCallback(() => {
		fetchNextPage()
	}, [fetchNextPage])
	const allCollapsed = groups.length > 0 && groups.every((g) => isCollapsed(g.key))
	useEffect(() => {
		const el = sentinel
		if (!el || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return
		if (allCollapsed) return
		if (typeof IntersectionObserver === 'undefined') return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) loadNextPage()
			},
			{ root: scrollRef.current, rootMargin: '200px' },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [sentinel, hasNextPage, isFetchingNextPage, isFetchNextPageError, loadNextPage, allCollapsed])

	const chipOf = (c: ConversationListItemResponse): string | null => {
		const sid = sectionOfChat.get(c.id)
		if (sid) return sectionName.get(sid) ?? null
		if (c.pinned) return 'Pinned'
		if (c.roomKind) return 'Room'
		return null
	}

	const sectionedRow = (c: ConversationListItemResponse, inSection = false) => (
		<DraggableRow key={c.id} id={c.id}>
			<ConversationListRow
				workspaceId={workspaceId}
				conversation={c}
				threadUnread={threadUnreadByChat.get(c.id) ?? 0}
				sectioned
				showPin={inSection && c.pinned}
				menuExtra={moveMenu(c)}
				onOpen={() => trackOpened(c.id)}
			/>
		</DraggableRow>
	)

	const viewList = activeView ? (
		<div className="flex flex-col gap-px">
			<div className="flex flex-col gap-1 px-2 pt-2 pb-3">
				<div className="flex items-center gap-2">
					<Button variant="link" size="sm" className="px-0" onClick={() => onFilterChange('all')}>
						Back to all chats
					</Button>
					{activeView === 'waiting' && viewRows.some((c) => (c.mentions_unread ?? 0) > 0) ? (
						<button
							type="button"
							onClick={markMentionsRead}
							className="ml-auto text-[12.5px] font-semibold text-muted-foreground hover:text-foreground"
						>
							Mark mentions read
						</button>
					) : null}
				</div>
				<h2 className="text-[15px] font-semibold text-foreground">{VIEW_COPY[activeView].title}</h2>
				<p className="text-[12.5px] text-muted-foreground">{VIEW_COPY[activeView].intro}</p>
			</div>
			{viewRows.map((c) => (
				<ConversationListRow
					key={c.id}
					workspaceId={workspaceId}
					conversation={c}
					threadUnread={threadUnreadByChat.get(c.id) ?? 0}
					sectioned
					reason={viewReason(activeView, c)}
					chip={chipOf(c)}
					menuExtra={moveMenu(c)}
					onOpen={() => trackOpened(c.id)}
				/>
			))}
		</div>
	) : null

	const newSectionButton = (
		<div className="px-2 py-1" key="new-section">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="gap-1.5 text-[12.5px] font-semibold text-muted-foreground"
				onClick={() => setCreating({})}
			>
				<Plus size={13} aria-hidden />
				New section
			</Button>
		</div>
	)
	// The "New section" row sits after the last section, or before Rooms and Agents when there is none.
	const newSectionAt = (() => {
		if (!scoped) return -1
		let last = -1
		groups.forEach((g, i) => {
			if (sectionIdOfGroup(g.key)) last = i
		})
		if (last >= 0) return last + 1
		const firstOther = groups.findIndex((g) => g.key !== 'pinned')
		return firstOther === -1 ? groups.length : firstOther
	})()

	const renderGroup = (group: (typeof groups)[number]): ReactNode => {
		const sid = sectionIdOfGroup(group.key)
		const section = sid ? sections.find((s) => s.id === sid) : undefined
		if (section) {
			const ordered = [...sections].sort((a, b) => a.position - b.position)
			const at = ordered.findIndex((s) => s.id === section.id)
			return (
				<ChatSectionGroup
					key={group.key}
					section={section}
					count={group.items.length}
					canMoveUp={at > 0}
					canMoveDown={at < ordered.length - 1}
					renaming={renamingId === section.id}
					sections={sections}
					onToggle={() =>
						updateSection.mutate({ id: section.id, data: { collapsed: !section.collapsed } })
					}
					onStartRename={() => setRenamingId(section.id)}
					onRename={async (name) => {
						await updateSection.mutateAsync({ id: section.id, data: { name } })
						setRenamingId(null)
					}}
					onCancelRename={() => setRenamingId(null)}
					onMove={(d) => shiftSection(section.id, d)}
					onDelete={() => removeSection(section)}
				>
					{group.items.map((c) => sectionedRow(c, true))}
				</ChatSectionGroup>
			)
		}
		const folded = isCollapsed(group.key)
		return (
			<ListDropZone key={group.key} id={group.key}>
				<div className="flex flex-col gap-px">
					<div className="flex items-center gap-2 px-2 pt-3.5 pb-3 text-[15px]">
						<button
							type="button"
							aria-expanded={!folded}
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
								className={cn('text-muted-foreground transition-transform', folded && '-rotate-90')}
							/>
							<span>{group.label}</span>
							<span className="font-medium text-muted-foreground">
								{group.entries?.length ?? group.items.length}
							</span>
						</button>
					</div>
					{folded
						? null
						: group.entries
							? group.entries.map((entry) =>
									entry.kind === 'agent' ? (
										<ConversationAgentRow
											key={entry.key}
											workspaceId={workspaceId}
											entry={entry}
											threadUnreadByChat={threadUnreadByChat}
											onOpen={trackOpened}
											sectioned
										/>
									) : (
										sectionedRow(entry.conversation)
									),
								)
							: group.items.map((c) => sectionedRow(c))}
				</div>
			</ListDropZone>
		)
	}

	const noChats = fetched.length === 0 && sections.length === 0
	const emptyCopy = EMPTY_COPY[filter] ?? EMPTY_COPY.all
	const viewEmpty = activeView !== null && viewRows.length === 0

	return (
		<div data-testid="conversation-list" className={cn('flex min-h-0 flex-1 flex-col', className)}>
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 lg:pr-4 lg:pl-10">
				<div className={cn('w-full', expanded && 'mx-auto max-w-[900px]')}>
					{tilesShown ? (
						<ChatViewTiles
							className="pb-2"
							active={activeView}
							counts={counts}
							onToggle={(v) => onFilterChange(activeView === v ? 'all' : VIEW_FILTER[v])}
						/>
					) : null}
					{creating ? (
						<SectionNameForm
							submitLabel="Add section"
							sections={sections}
							onSubmit={addSection}
							onCancel={() => setCreating(null)}
						/>
					) : null}
					{showQuietNote ? (
						<QuietNote
							count={quietCount}
							onView={() => {
								dismissNote()
								onFilterChange('quiet')
							}}
							onDismiss={dismissNote}
						/>
					) : null}
					{searching ? (
						<ConversationSearchResults
							workspaceId={workspaceId}
							query={needle}
							search={search}
							known={known}
							loaded={loaded}
							onOpen={trackSearchOpened}
						/>
					) : isLoading ? (
						<ListSkeleton rows={8} />
					) : isError ? (
						<EmptyState
							icon={<MessageCircleWarning size={24} aria-hidden="true" />}
							title={
								activeView ? `Couldn't load ${VIEW_COPY[activeView].title}` : "Couldn't load chats"
							}
							description="Check your connection and try again."
							action={
								<div className="flex items-center gap-2">
									<Button variant="outline" size="sm" onClick={() => refetch()}>
										Try again
									</Button>
									{activeView ? (
										<Button variant="ghost" size="sm" onClick={() => onFilterChange('all')}>
											Back to all chats
										</Button>
									) : null}
								</div>
							}
						/>
					) : activeView && viewEmpty ? (
						<EmptyState
							icon={<MessageCircle size={24} aria-hidden="true" />}
							title={VIEW_COPY[activeView].emptyTitle}
							description={VIEW_COPY[activeView].emptyBody}
							action={
								<Button variant="link" size="sm" onClick={() => onFilterChange('all')}>
									Back to all chats
								</Button>
							}
						/>
					) : activeView ? (
						viewList
					) : noChats ? (
						<EmptyState
							icon={<MessageCircle size={24} aria-hidden="true" />}
							title={emptyCopy?.title ?? 'No chats yet'}
							description={emptyCopy?.description}
							action={
								filter === 'all' ? (
									hideStartLink ? undefined : (
										<Button asChild variant="link" size="sm">
											<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
												Start a new one →
											</Link>
										</Button>
									)
								) : (
									<Button variant="link" size="sm" onClick={() => onFilterChange('all')}>
										View all chats →
									</Button>
								)
							}
						/>
					) : (
						<DndContext
							sensors={sensors}
							onDragStart={(e) => setDragging(known.get(String(e.active.id)) ?? null)}
							onDragCancel={() => setDragging(null)}
							onDragEnd={onDragEnd}
						>
							{groups.map((group, i) => (
								<div key={group.key}>
									{i === newSectionAt ? newSectionButton : null}
									{renderGroup(group)}
								</div>
							))}
							{newSectionAt >= groups.length ? newSectionButton : null}
							<DragOverlay>
								{dragging ? (
									<div className="w-fit max-w-xs truncate rounded-lg bg-background px-3 py-2 text-sm font-semibold shadow-lg">
										{dragging.title}
									</div>
								) : null}
							</DragOverlay>
							{scoped && quietCount > 0 ? (
								<QuietFooter count={quietCount} onView={() => onFilterChange('quiet')} />
							) : null}
						</DndContext>
					)}
					{!searching && !isLoading && !isError && hasNextPage ? (
						<div
							ref={setSentinel}
							className="flex items-center justify-center gap-2 px-3 pt-4 pb-2.5 text-[11px] text-muted-foreground"
						>
							{isFetchingNextPage ? (
								<>
									<Spinner />
									Loading older conversations…
								</>
							) : isFetchNextPageError ? (
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
				</div>
			</div>
		</div>
	)
}
