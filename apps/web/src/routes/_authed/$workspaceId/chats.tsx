import { type ChatsFilter, ChatsFilterMenu } from '@/components/chat/chats-filter-menu'
import { ConversationList } from '@/components/chat/conversation-list'
import { PageHeader } from '@/components/layout/page-header'
import { useChatUnreadCount } from '@/hooks/use-chat-unread'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Outlet, createFileRoute, useMatches, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

interface ChatsSearch {
	filter?: ChatsFilter
	/** Desktop focus mode — hides the list pane and widens the thread gutter. */
	wide?: boolean
}

const FILTER_VALUES: ChatsFilter[] = ['all', 'unread', 'pinned', 'archived']

export const Route = createFileRoute('/_authed/$workspaceId/chats')({
	component: ChatsLayout,
	// Search-param state (not useState) so the filter and focus mode survive a
	// reload and are assertable from E2E. Defaults are returned as `undefined`
	// so they never appear in the URL.
	validateSearch: (search: Record<string, unknown>): ChatsSearch => {
		const filter = FILTER_VALUES.find((f) => f === search.filter)
		return {
			filter: filter && filter !== 'all' ? filter : undefined,
			wide: search.wide === true || search.wide === 'true' ? true : undefined,
		}
	},
})

// Leaf routes that render a thread pane — on mobile these replace the list
// instead of stacking beside it.
const THREAD_ROUTE_IDS = new Set([
	'/_authed/$workspaceId/chats/$conversationId',
	'/_authed/$workspaceId/chats/new',
])

function ChatsLayout() {
	const { workspaceId } = useWorkspace()
	const isMobile = useIsMobile()
	const navigate = useNavigate()
	const matches = useMatches()
	const { filter = 'all', wide } = Route.useSearch()
	const leafMatch = matches[matches.length - 1]
	const hasThread = !!leafMatch && THREAD_ROUTE_IDS.has(leafMatch.routeId)
	const isDraft = leafMatch?.routeId === '/_authed/$workspaceId/chats/new'

	const { count: unreadCount } = useChatUnreadCount(workspaceId)
	const { data } = useConversationsInfinite(workspaceId)
	const total = data?.pages.flatMap((p) => p.conversations).length ?? 0
	const subtitle =
		unreadCount > 0
			? `${unreadCount} unread`
			: `${total} ${total === 1 ? 'conversation' : 'conversations'}`

	const handleFilterChange = useCallback(
		(next: ChatsFilter) => {
			navigate({
				to: '/$workspaceId/chats',
				params: { workspaceId },
				search: (prev: ChatsSearch) => ({
					...prev,
					filter: next === 'all' ? undefined : next,
				}),
			})
		},
		[navigate, workspaceId],
	)

	// One writer for the shared nav row: a child route rendering its own
	// <PageHeader> would lose the race (parent effects run last) and leave the
	// draft screen labelled "Chats".
	const header = (
		<PageHeader
			title={isDraft ? 'New chat' : 'Chats'}
			subtitle={isDraft ? undefined : subtitle}
			// The split pane owns two internal scrollers; without this the shared
			// page container scrolls too and the surface double-scrolls.
			scrollLocked
			actions={<ChatsFilterMenu value={filter} onChange={handleFilterChange} />}
		/>
	)

	// Full-bleed: reclaim the workspace shell's page padding (`p-4 md:p-8` on
	// `data-scroll-root` in `$workspaceId.tsx`) so the split pane gets the
	// full content width. At exactly 768px (iPad portrait — the narrowest
	// viewport that still gets the two-pane layout), that padding alone was
	// enough to squeeze the thread header's title down to a few visible
	// pixels next to its fixed-width controls (participants pill, pin,
	// archive, copy) — see the known-pitfalls-style regression this fixed.
	if (isMobile) {
		return (
			<>
				{header}
				{hasThread ? (
					<div className="-m-4 flex min-h-0 flex-1 flex-col">
						<Outlet />
					</div>
				) : (
					<ConversationList workspaceId={workspaceId} filter={filter} className="-m-4" />
				)}
			</>
		)
	}

	// Desktop with nothing selected: the list spans the whole content width and
	// the thread pane isn't mounted at all (mockup 8124–8125).
	if (!hasThread) {
		return (
			<>
				{header}
				<ConversationList
					workspaceId={workspaceId}
					filter={filter}
					expanded
					className="-m-4 md:-m-8"
				/>
			</>
		)
	}

	return (
		<>
			{header}
			<div className="-m-4 flex min-h-0 flex-1 md:-m-8">
				{wide ? null : (
					<div className="hidden w-[clamp(266px,25vw,326px)] shrink-0 flex-col border-r border-border md:flex">
						<ConversationList workspaceId={workspaceId} filter={filter} />
					</div>
				)}
				<div
					className={cn(
						'flex min-w-0 flex-1 flex-col',
						wide && 'md:px-[max(28px,calc((100%-900px)/2))]',
					)}
				>
					<Outlet />
				</div>
			</div>
		</>
	)
}
