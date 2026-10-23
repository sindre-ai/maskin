import type { LinkedFocus } from '@/components/chat/linked-pane'
import { LinkedPanelContext } from '@/components/chat/linked-panel-context'
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
	useSendMessage,
} from '@/hooks/use-conversation'
import { useSessionBudgetStopToast } from '@/hooks/use-conversation-activity'
import { useConversationLinked, useResolvedLinkedItems } from '@/hooks/use-conversation-linked'
import { useConversationProduced } from '@/hooks/use-conversation-produced'
import { useConversationThreads } from '@/hooks/use-conversation-threads'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useIsDesktopViewport } from '@/hooks/use-mobile'
import { useOriginDeepLinkScroll } from '@/hooks/use-origin-deep-link-scroll'
import type { MessageMetadata } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
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
	const { produced: producedSearch } = useSearch({ from: '/_authed/$workspaceId/chats' })
	const producedRequested = !!producedSearch
	const sendMessage = useSendMessage(conversationId, workspaceId)
	// A fill step asks the composer to take its prompt; a send step asks it only to
	// take focus, so the person can follow up (the tapped button is gone by then).
	// The nonce makes the same request twice a new one; it is dropped with the chat.
	const [fillRequest, setFillRequest] = useState<{ text?: string; nonce: number } | null>(null)
	const fillNonceRef = useRef(0)
	const requestComposer = useCallback((text?: string) => {
		fillNonceRef.current += 1
		setFillRequest({ text, nonce: fillNonceRef.current })
	}, [])
	const sendStep = useCallback(
		(content: string, metadata: MessageMetadata) => {
			sendMessage.mutate({ content, metadata })
			requestComposer()
		},
		[sendMessage.mutate, requestComposer],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the trigger, its value is not read
	useEffect(() => {
		setFillRequest(null)
	}, [conversationId])
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
	const computersCount = (conversation?.participants ?? []).filter(
		(p) => p.actorType === 'agent',
	).length
	const messagesOldestFirst = useMemo(
		() => flattenMessagesOldestFirst(messagesData),
		[messagesData],
	)
	const derivedLinked = useConversationLinked(messagesOldestFirst)
	const { items: linkedItems, count: linkedCount } = useResolvedLinkedItems(
		derivedLinked,
		workspaceId,
	)
	const [linkedFocus, setLinkedFocus] = useState<LinkedFocus | null>(null)
	const focusNonceRef = useRef(0)
	const linkedPanel = useMemo(
		() => ({
			openLinked: (target: { kind: 'object' | 'file'; id: string }) => {
				focusNonceRef.current += 1
				setLinkedFocus({ ...target, nonce: focusNonceRef.current })
				setOverview({ tab: 'linked', sessionId: null })
			},
		}),
		[],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the trigger, its value is not read
	useEffect(() => {
		setLinkedFocus(null)
	}, [conversationId])
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
	} = useConversationProduced(workspaceId, conversationId)

	const toggleOverview = useCallback(() => {
		setOverview((prev) => (prev ? null : { tab: 'threads', sessionId: null }))
	}, [])

	// Pulse the Overview dot when threads or produced items changed since the
	// pane was last open. "Seen" is remembered per chat so a reload doesn't
	// re-announce what the person already looked at.
	const overviewSignature = useMemo(
		() =>
			`${threads.map((t) => `${t.id}:${t.status}:${t.awaiting ? 'w' : ''}`).join('|')}#${totalCount}#${linkedCount}`,
		[threads, totalCount, linkedCount],
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
		!overview &&
		(threads.length > 0 || totalCount > 0 || linkedCount > 0) &&
		overviewSignature !== seenSignature

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

	// Jump to message: the same pulse the Origin deep-link uses, set directly because that hook
	// fires once per message id. On a bottom sheet the sheet closes first so the transcript is
	// in view.
	const jumpTimerRef = useRef<number | null>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the trigger, its value is not read
	useEffect(
		() => () => {
			if (jumpTimerRef.current !== null) window.clearTimeout(jumpTimerRef.current)
		},
		[conversationId],
	)
	const jumpToMessage = useCallback(
		(messageId: number) => {
			if (!isDesktop) setOverview(null)
			if (jumpTimerRef.current !== null) window.clearTimeout(jumpTimerRef.current)
			jumpTimerRef.current = window.setTimeout(
				() => {
					jumpTimerRef.current = null
					const node = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
					if (!node) {
						// Older than the pages loaded so far; the transcript loads more as it scrolls up.
						toast.info('That message is further up. Scroll up in the chat to load it.')
						return
					}
					node.scrollIntoView({ behavior: 'smooth', block: 'start' })
					node.dataset.originPulse = 'true'
					window.setTimeout(() => delete node.dataset.originPulse, 2200)
				},
				isDesktop ? 0 : 300,
			)
		},
		[isDesktop],
	)
	const consumeLinkedFocus = useCallback(() => setLinkedFocus(null), [])
	// A focus request that was never acted on (item not listed) must not linger into a later open.
	const linkedTabOpen = overview?.tab === 'linked'
	useEffect(() => {
		if (!linkedTabOpen) setLinkedFocus(null)
	}, [linkedTabOpen])

	const overviewNode = overview ? (
		<OverviewPane
			workspaceId={workspaceId}
			conversationId={conversationId}
			tab={overview.tab}
			onTabChange={(tab) => setOverview({ tab, sessionId: null })}
			threadsCount={threads.length}
			computersCount={computersCount}
			producedCount={totalCount}
			openSessionId={overview.sessionId}
			onOpenSession={(sessionId) => setOverview({ tab: 'threads', sessionId })}
			producedObjects={producedObjects}
			producedFiles={producedFiles}
			producedLoading={producedLoading}
			linkedItems={linkedItems}
			linkedCount={linkedCount}
			linkedFocus={linkedFocus}
			onFocusConsumed={consumeLinkedFocus}
			onJumpToMessage={jumpToMessage}
			onClose={() => setOverview(null)}
			className="h-full"
		/>
	) : null

	return (
		<LinkedPanelContext.Provider value={linkedPanel}>
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
							overviewOpen={overview !== null}
							overviewHasNew={overviewHasNew}
							onToggleOverview={toggleOverview}
						/>
						<ThreadMessages
							workspaceId={workspaceId}
							conversationId={conversationId}
							onPickStep={requestComposer}
							onSendStep={sendStep}
							sendingStep={sendMessage.isPending}
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
							<ThreadComposer
								workspaceId={workspaceId}
								conversationId={conversationId}
								fillRequest={fillRequest}
							/>
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
										Work this chat handed to other agents, what it produced, and what it links to.
									</SheetDescription>
								</SheetHeader>
								{overviewNode}
							</SheetContent>
						</Sheet>
					) : null}
				</div>
			</ThreadsPaneContext.Provider>
		</LinkedPanelContext.Provider>
	)
}
