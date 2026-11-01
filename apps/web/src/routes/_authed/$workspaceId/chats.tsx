import { type ChatsFilter, ChatsFilterMenu } from '@/components/chat/chats-filter-menu'
import { ConversationList } from '@/components/chat/conversation-list'
import { PageHeader } from '@/components/layout/page-header'
import { useChatUnreadCount } from '@/hooks/use-chat-unread'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'
import { useVoiceCallLive } from '@/lib/voice-call-view'
import { useWorkspace } from '@/lib/workspace-context'
import { Outlet, createFileRoute, useMatches, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

interface ChatsSearch {
	filter?: ChatsFilter
	/** Desktop focus mode — hides the list pane. */
	wide?: boolean
	/** S2 · Produced pane state (bet 34706e2f, task 5). Persisted in the URL
	 *  so a reload keeps the pane open; the toggle in ThreadHeader flips it
	 *  and the `P` shortcut on the conversation route does the same. Undefined
	 *  when closed (never appears in the URL for the default state). */
	produced?: boolean
}

const FILTER_VALUES: ChatsFilter[] = ['all', 'unread', 'pinned', 'archived', 'threads']

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
			produced: search.produced === true || search.produced === 'true' ? true : undefined,
		}
	},
})

// Leaf routes that render a thread pane — on mobile these replace the list
// instead of stacking beside it.
const THREAD_ROUTE_IDS = new Set([
	'/_authed/$workspaceId/chats/$conversationId',
	'/_authed/$workspaceId/chats/new',
])

// The list-only states never mount the index leaf route, so the list sets its
// own title. Rendered only while no thread is open: a thread leaf sets the
// conversation title itself, and this layout's effects would run after it.
function ChatsListTitle() {
	useDocumentTitle('Chats')
	return null
}

// Cancels MainScrollArea's padding (`px-4 pt-4`, `md:px-8 md:py-8`, `lg:px-12`
// in `$workspaceId.tsx`) so the split pane runs edge to edge. Keep in step.
const SHELL_BLEED = '-mx-4 -my-4 md:-mx-8 md:-my-8 lg:-mx-12'

// The list column draws its own title (the shared header hides its <h1> via
// `hideTitle`), on the same `.page-title` size and side margin every other
// screen uses so the "Chats" heading sits on the shared left edge.
function ChatsColumnTitle({ subtitle }: { subtitle?: string }) {
	return (
		<div className="flex flex-none items-baseline gap-2 px-4 pt-5 pb-2 md:px-8 lg:px-12">
			<h2 className="page-title truncate">Chats</h2>
			{subtitle && (
				<span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{subtitle}</span>
			)}
		</div>
	)
}

function ChatsLayout() {
	const { workspaceId } = useWorkspace()
	const isMobile = useIsMobile()
	// The list sits beside the thread; with the call panel open as well, the
	// thread would be squeezed below 360px under about 1280px, so the list steps
	// aside for the length of the call.
	const onCall = useVoiceCallLive()
	const narrowForCall = useMediaQuery('(max-width: 1279px)')
	const listAside = onCall && narrowForCall
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

	// Stay on whatever chats route is currently mounted (`to: '.'`) and rewrite
	// only the search params. Navigating to `/$workspaceId/chats` instead would
	// drop the `$conversationId` leaf, so re-filtering while reading a thread
	// closed the thread out from under the reader.
	const handleFilterChange = useCallback(
		(next: ChatsFilter) => {
			navigate({
				to: '.',
				search: (prev: ChatsSearch) => ({
					...prev,
					filter: next === 'all' ? undefined : next,
				}),
			})
		},
		[navigate],
	)

	// One writer for the shared nav row: a child route rendering its own
	// <PageHeader> would lose the race (parent effects run last) and leave the
	// draft screen labelled "Chats".
	// The list column (with its own "Chats" title) is on screen unless a thread
	// has replaced it (mobile) or focus mode / the call panel moved it aside.
	// The draft screen keeps the shared "New chat" title.
	const listShown = !hasThread || (!isMobile && !wide && !listAside)
	const columnTitle = listShown && !isDraft
	const header = (
		<PageHeader
			title={isDraft ? 'New chat' : 'Chats'}
			hideTitle={columnTitle}
			subtitle={isDraft || columnTitle ? undefined : subtitle}
			// The split pane owns two internal scrollers; without this the shared
			// page container scrolls too and the surface double-scrolls.
			scrollLocked
			actions={<ChatsFilterMenu value={filter} onChange={handleFilterChange} />}
		/>
	)

	// Full-bleed: reclaim the workspace shell's page padding (`px-4 pt-4 md:px-8 md:py-8 lg:px-12` on
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
				{hasThread ? null : <ChatsListTitle />}
				{hasThread ? (
					<div
						className={cn(
							'flex min-h-0 flex-1 flex-col [--chat-gut:clamp(14px,3vw,28px)]',
							SHELL_BLEED,
						)}
					>
						<Outlet />
					</div>
				) : (
					<div className={cn('flex min-h-0 flex-1 flex-col', SHELL_BLEED)}>
						<ChatsColumnTitle subtitle={subtitle} />
						<ConversationList workspaceId={workspaceId} filter={filter} />
					</div>
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
				<ChatsListTitle />
				<div className={cn('flex min-h-0 flex-1 flex-col', SHELL_BLEED)}>
					<ChatsColumnTitle subtitle={subtitle} />
					<ConversationList workspaceId={workspaceId} filter={filter} expanded />
				</div>
			</>
		)
	}

	return (
		<>
			{header}
			<div className={cn('flex min-h-0 flex-1', SHELL_BLEED)}>
				{wide || listAside ? null : (
					// `bg-surface-sunken` is what makes the split read as index +
					// document rather than two equal halves (mockup 273).
					<div className="hidden shrink-0 flex-col border-r border-border bg-surface-sunken md:flex md:w-66 lg:w-100">
						<ChatsColumnTitle subtitle={subtitle} />
						<ConversationList workspaceId={workspaceId} filter={filter} />
					</div>
				)}
				{/* One gutter variable for the whole thread pane — the header,
				    transcript and composer all read `--chat-gut` so they can never
				    drift apart, and on desktop the value is a centring margin
				    (a 900px column) instead of padding on top of the base gutter
				    (mockup 7763). */}
				<div className="flex min-w-0 flex-1 flex-col [--chat-gut:clamp(14px,3vw,28px)] md:[--chat-gut:max(28px,calc((100%-900px)/2))]">
					<Outlet />
				</div>
			</div>
		</>
	)
}
