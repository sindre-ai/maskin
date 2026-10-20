import { OverviewPane, type OverviewTab } from '@/components/chat/overview-pane'
import { ThreadComposer } from '@/components/chat/thread-composer'
import { ThreadHeader } from '@/components/chat/thread-header'
import { ThreadMessages } from '@/components/chat/thread-messages'
import { ThreadsPaneContext } from '@/components/chat/threads-context'
import { RouteError } from '@/components/shared/route-error'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@/components/ui/sheet'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import { useSessionBudgetStopToast } from '@/hooks/use-conversation-activity'
import { useConversationProduced } from '@/hooks/use-conversation-produced'
import { useConversationThreads } from '@/hooks/use-conversation-threads'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useIsDesktopViewport } from '@/hooks/use-mobile'
import { useOriginDeepLinkScroll } from '@/hooks/use-origin-deep-link-scroll'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'

// `?msg=<message id>` is the Origin block's deep-link — see `<Origin>` at
// `apps/web/src/components/objects/origin.tsx`. Number-typed here so a
// malformed param can't smuggle a non-numeric selector into
// `[data-message-id="..."]` down below (and so the router preserves the
// typed value across re-serialisation). Anything unparseable is dropped.
const chatSearchSchema = z.object({
	msg: z.coerce.number().int().positive().optional(),
})

const SEEN_KEY = (conversationId: string) => `maskin-overview-seen:${conversationId}`

function readSeenOverview(conversationId: string): string | null {
	try {
		return localStorage.getItem(SEEN_KEY(conversationId))
	} catch {
		return null
	}
}

function writeSeenOverview(conversationId: string, signature: string) {
	try {
		localStorage.setItem(SEEN_KEY(conversationId), signature)
	} catch {
		// Storage can be blocked; the dot then just re-pulses on reload.
	}
}

export const Route = createFileRoute('/_authed/$workspaceId/chats/$conversationId')({
	component: ConversationThreadPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: chatSearchSchema,
})

function ConversationThreadPage() {
	const { conversationId } = Route.useParams()
	const { msg: deepLinkMessageId } = Route.useSearch()
	const { workspaceId } = useWorkspace()
	const { data: conversation } = useConversation(conversationId, workspaceId)
	useDocumentTitle(conversation?.title)
	const { data: messagesData } = useConversationMessages(conversationId, workspaceId)
	const updateMe = useUpdateConversationMe(workspaceId)
	// Feature-flag boundary for the chats v4 polish bet (bet/bdda1c1e-chats-v4-polish).
	// Read once at this route per the feature-flags rule
	// (`.claude/rules/feature-flags.md`) and threaded down as boolean props. Each
	// delta is additionally gated by its own sub-flag (`.header` / `.banner` /
	// `.bubbles`) so a single delta can be reverted without dropping the rest.
	const chatsV4Enabled = useFeatureFlag('chats-v4-polish')
	const headerV4Enabled = useFeatureFlag('chats-v4-polish.header')
	const bannerV4Enabled = useFeatureFlag('chats-v4-polish.banner')
	const bubblesV4Enabled = useFeatureFlag('chats-v4-polish.bubbles')
	// S2 · Produced pane boundary (bet 34706e2f, task 5). One flag read at
	// this route — the ThreadHeader toggle mounts iff on, the ProducedPane
	// mounts iff on, and the P shortcut only registers iff on. Shares the
	// bet's writer flag (`graph-provenance-writes`) so a tester actor gets
	// writes AND read UI in one flip, per bet spec §Slice 2 §Feature flag.
	const producedEnabled = useFeatureFlag('graph-provenance-writes')
	const { produced: producedSearch } = useSearch({ from: '/_authed/$workspaceId/chats' })
	const producedRequested = producedEnabled && !!producedSearch
	const navigate = useNavigate()
	// Desktop (≥1024) gets the persistent right-rail column when open;
	// everything smaller (mobile + tablet portrait/landscape at 641-1023) opens
	// the pane as a bottom Sheet — the "no persistent third column" rail from
	// the acceptance criteria.
	const isDesktop = useIsDesktopViewport()
	// Right-rail Overview (Threads + Produced tabs): local state, not a search
	// param — a transient view over data already on the page. `?produced` still
	// deep-links in, opening it on the Produced tab.
	const [overview, setOverview] = useState<null | {
		tab: OverviewTab
		sessionId: string | null
	}>(() => (producedRequested ? { tab: 'produced', sessionId: null } : null))
	const threads = useConversationThreads(workspaceId, conversationId)
	const threadsContext = useMemo(
		() => ({
			openThread: (sessionId: string) => setOverview({ tab: 'threads', sessionId }),
		}),
		[],
	)
	const lastMarkedRef = useRef<number | null>(null)
	useSessionBudgetStopToast(workspaceId, conversationId)

	// Chat-level aggregate — one events fetch per chat time-window, shared
	// with the header count pill and the pane's body render. Enabled only
	// when the flag lights so a non-tester workspace never fires the query.
	const {
		producedObjects,
		producedFiles,
		totalCount,
		isLoading: producedLoading,
	} = useConversationProduced(workspaceId, conversationId, producedEnabled)

	const toggleOverview = useCallback(() => {
		setOverview((prev) => (prev ? null : { tab: 'threads', sessionId: null }))
	}, [])

	// Pulse the Overview dot when threads or produced items changed since the
	// pane was last open. "Seen" is remembered per chat so a reload doesn't
	// re-announce what the person already looked at.
	const overviewSignature = useMemo(
		() =>
			`${threads.map((t) => `${t.id}:${t.status}:${t.awaiting ? 'w' : ''}`).join('|')}#${totalCount}`,
		[threads, totalCount],
	)
	const [seenSignature, setSeenSignature] = useState<string | null>(() =>
		readSeenOverview(conversationId),
	)
	useEffect(() => {
		setSeenSignature(readSeenOverview(conversationId))
	}, [conversationId])
	useEffect(() => {
		if (!overview) return
		setSeenSignature(overviewSignature)
		writeSeenOverview(conversationId, overviewSignature)
	}, [overview, overviewSignature, conversationId])
	const overviewHasNew =
		!overview && (threads.length > 0 || totalCount > 0) && overviewSignature !== seenSignature

	// Mark the newest message read once it's loaded — mirrors the "open = read"
	// convention used elsewhere (subscriptions markRead on open).
	// biome-ignore lint/correctness/useExhaustiveDependencies: updateMe is a stable mutation handle; including it would rerun this on every render without changing behavior
	useEffect(() => {
		if (!conversation) return
		const messages = flattenMessagesOldestFirst(messagesData)
		const newest = messages[messages.length - 1]
		if (!newest || newest.id <= 0) return
		if (newest.id === conversation.last_read_message_id) return
		if (lastMarkedRef.current === newest.id) return
		lastMarkedRef.current = newest.id
		updateMe.mutate({ id: conversationId, data: { last_read_message_id: newest.id } })
	}, [conversation, messagesData, conversationId])

	// P toggles the Overview pane. Skipped when the user is typing in an
	// editable element (input/textarea/contentEditable) so composer keystrokes
	// aren't hijacked — same shape as the shortcut policy in the command
	// palette.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return
			if (e.key !== 'p' && e.key !== 'P') return
			const target = e.target as HTMLElement | null
			if (!target) return
			const tag = target.tagName
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
			e.preventDefault()
			toggleOverview()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [toggleOverview])

	const announcement = useOriginDeepLinkScroll({
		messageId: deepLinkMessageId ?? null,
		dataTrigger: messagesData,
	})

	const overviewNode = overview ? (
		<OverviewPane
			workspaceId={workspaceId}
			conversationId={conversationId}
			tab={overview.tab}
			onTabChange={(tab) => setOverview({ tab, sessionId: null })}
			producedEnabled={producedEnabled}
			threadsCount={threads.length}
			producedCount={totalCount}
			openSessionId={overview.sessionId}
			onOpenSession={(sessionId) => setOverview({ tab: 'threads', sessionId })}
			producedObjects={producedObjects}
			producedFiles={producedFiles}
			producedLoading={producedLoading}
			onClose={() => setOverview(null)}
			className="h-full"
		/>
	) : null

	return (
		<ThreadsPaneContext.Provider value={threadsContext}>
			<div className="flex min-h-0 flex-1">
				{/* `min-w-0` caps min-content on the cross axis so a wide descendant
			    (markdown table, long unbroken URL) can't widen this column past the
			    viewport. Without it the column — and its header/composer children —
			    blow out past the phone's right edge, which `overflow-x: clip` on
			    html/body then hides instead of surfacing as a scrollbar. */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<ThreadHeader
						workspaceId={workspaceId}
						conversationId={conversationId}
						v4Polish={chatsV4Enabled && headerV4Enabled}
						overviewOpen={overview !== null}
						overviewHasNew={overviewHasNew}
						onToggleOverview={toggleOverview}
					/>
					<ThreadMessages
						workspaceId={workspaceId}
						conversationId={conversationId}
						v4PolishBanner={chatsV4Enabled && bannerV4Enabled}
						v4PolishBubbles={chatsV4Enabled && bubblesV4Enabled}
						producedEnabled={producedEnabled}
					/>
					{/* Live region for the Origin deep-link jump — announced once per
				    navigation (spec §7 accessibility). Kept out of ThreadMessages so
				    it isn't torn down when the message list scrolls. `<output>` has
				    an implicit `role="status"` + `aria-live="polite"`. */}
					<output className="sr-only">{announcement}</output>
					{/* No rule above the composer (mockup 517): the composer draws its own
				    border, and a second full-bleed hairline behind it cut the thread in
				    half. The gutter matches the header's and the transcript's so the
				    three stack on one vertical edge. */}
					<div className="shrink-0 px-[var(--chat-gut)] pt-2.5 pb-3.5">
						<ThreadComposer workspaceId={workspaceId} conversationId={conversationId} />
					</div>
				</div>
				{/* Desktop (≥1024): persistent right-rail column at 320px, sliding
			    in on --duration-slide + ease-emphasized. Reduced motion drops the
			    animation via `motion-reduce:animate-none` — the underlying
			    Tailwind utility zeros the duration to the base ~0ms, matching
			    the "Reduced motion drops to 0.001ms" requirement. */}
				{overview && isDesktop ? (
					<aside
						aria-label="Overview pane"
						className="duration-slide ease-emphasized w-[400px] shrink-0 border-l border-border motion-safe:animate-in motion-safe:slide-in-from-right motion-reduce:animate-none xl:w-[440px]"
					>
						{overviewNode}
					</aside>
				) : null}
				{overview && !isDesktop ? (
					<Sheet open onOpenChange={(open) => !open && setOverview(null)}>
						<SheetContent side="bottom" className="h-[85dvh] rounded-t-lg p-0" hideCloseButton>
							<SheetHeader className="sr-only">
								<SheetTitle>Overview</SheetTitle>
								<SheetDescription>
									Work this chat handed to other agents, and what it produced.
								</SheetDescription>
							</SheetHeader>
							{overviewNode}
						</SheetContent>
					</Sheet>
				) : null}
			</div>
		</ThreadsPaneContext.Provider>
	)
}
