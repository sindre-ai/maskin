import { ThreadComposer } from '@/components/chat/thread-composer'
import { ThreadHeader } from '@/components/chat/thread-header'
import { ThreadMessages } from '@/components/chat/thread-messages'
import { ProducedPane } from '@/components/objects/produced-pane'
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
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useIsDesktopViewport } from '@/hooks/use-mobile'
import { useOriginDeepLinkScroll } from '@/hooks/use-origin-deep-link-scroll'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'

// `?msg=<message id>` is the Origin block's deep-link — see `<Origin>` at
// `apps/web/src/components/objects/origin.tsx`. Number-typed here so a
// malformed param can't smuggle a non-numeric selector into
// `[data-message-id="..."]` down below (and so the router preserves the
// typed value across re-serialisation). Anything unparseable is dropped.
const chatSearchSchema = z.object({
	msg: z.coerce.number().int().positive().optional(),
})

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
	const producedOpen = producedEnabled && !!producedSearch
	const navigate = useNavigate()
	// Desktop (≥1024) gets the persistent right-rail column when open;
	// everything smaller (mobile + tablet portrait/landscape at 641-1023) opens
	// the pane as a bottom Sheet — the "no persistent third column" rail from
	// the acceptance criteria.
	const isDesktop = useIsDesktopViewport()
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

	const toggleProduced = useCallback(() => {
		navigate({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId, conversationId },
			search: (prev: { produced?: boolean }) => ({
				...prev,
				produced: prev.produced ? undefined : true,
			}),
		})
	}, [navigate, workspaceId, conversationId])

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

	// P toggles the Produced pane. Skipped when the user is typing in an
	// editable element (input/textarea/contentEditable) so composer keystrokes
	// aren't hijacked — same shape as the shortcut policy in the command
	// palette. Only registers when the flag is on so non-tester actors don't
	// carry a listener at all.
	useEffect(() => {
		if (!producedEnabled) return
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return
			if (e.key !== 'p' && e.key !== 'P') return
			const target = e.target as HTMLElement | null
			if (!target) return
			const tag = target.tagName
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
			e.preventDefault()
			toggleProduced()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [producedEnabled, toggleProduced])

	const announcement = useOriginDeepLinkScroll({
		messageId: deepLinkMessageId ?? null,
		dataTrigger: messagesData,
	})

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-h-0 flex-1 flex-col">
				<ThreadHeader
					workspaceId={workspaceId}
					conversationId={conversationId}
					v4Polish={chatsV4Enabled && headerV4Enabled}
					producedEnabled={producedEnabled}
					producedCount={totalCount}
					producedOpen={producedOpen}
					onToggleProduced={producedEnabled ? toggleProduced : undefined}
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
			{producedEnabled && producedOpen && isDesktop ? (
				<aside
					aria-label="Produced pane"
					className="duration-slide ease-emphasized w-[320px] shrink-0 border-l border-border motion-safe:animate-in motion-safe:slide-in-from-right motion-reduce:animate-none"
				>
					<ProducedPane
						workspaceId={workspaceId}
						producedObjects={producedObjects}
						producedFiles={producedFiles}
						isLoading={producedLoading}
					/>
				</aside>
			) : null}
			{producedEnabled && !isDesktop ? (
				<Sheet
					open={producedOpen}
					onOpenChange={(open) => {
						if (!open) toggleProduced()
					}}
				>
					<SheetContent side="bottom" className="h-[85dvh] rounded-t-lg p-0" hideCloseButton>
						<SheetHeader className="sr-only">
							<SheetTitle>Produced</SheetTitle>
							<SheetDescription>
								Objects and files produced downstream of this chat's sessions.
							</SheetDescription>
						</SheetHeader>
						<ProducedPane
							workspaceId={workspaceId}
							producedObjects={producedObjects}
							producedFiles={producedFiles}
							isLoading={producedLoading}
							onClose={toggleProduced}
							className="h-full"
						/>
					</SheetContent>
				</Sheet>
			) : null}
		</div>
	)
}
