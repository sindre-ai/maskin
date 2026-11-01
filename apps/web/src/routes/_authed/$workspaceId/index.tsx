import { BriefingRow } from '@/components/foryou/briefing-row'
import type { DraftAction } from '@/components/foryou/draft-stack'
import { type DecidedOption, FeedCard } from '@/components/foryou/feed-card'
import {
	type FeedMode,
	type ForYouBulkAction,
	ForYouHeader,
} from '@/components/foryou/foryou-header'
import { OnboardingPromptCard } from '@/components/foryou/onboarding-prompt-card'
import { TakeSuggestedDialog } from '@/components/foryou/take-suggested-dialog'
import { PageHeader } from '@/components/layout/page-header'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useForYou } from '@/hooks/use-for-you'
import { useMarkRead, useMarkUnread } from '@/hooks/use-subscriptions'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { trackForyouCardMarkedRead } from '@/lib/analytics'
import {
	type CreateCommentInput,
	type DisplaySettingsBody,
	type LatestMentionDecisionDraft,
	type UnreadItem,
	api,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	cardHeadline,
	classifyCardKind,
	isSendingOption,
	recommendedAction,
} from '@/lib/foryou-card-kind'
import { type FeedBucket, bucketRank, feedItemKey, feedTailLabel } from '@/lib/foryou-feed'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { CHROME_KEY } from '@maskin/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouFeed,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const UNDO_WINDOW_MS = 15_000

// The persisted display-setting field spells the card mode as `'card'`, while
// the feed's internal FeedMode spells it `'cards'`. These two mappings keep the
// rename in one place so the route and its tests can't drift.
export function foryouViewModeToFeedMode(
	persisted: DisplaySettingsBody['foryouViewMode'],
): FeedMode {
	return persisted === 'list' ? 'list' : 'cards'
}

export function feedModeToForyouViewMode(
	mode: FeedMode,
): NonNullable<DisplaySettingsBody['foryouViewMode']> {
	return mode === 'cards' ? 'card' : 'list'
}

/**
 * For You — the feed (mockup `Maskin For You - Feed v4`).
 *
 * A single scrolling column: the briefing cards, then every unread thread as a
 * card. Cards view expands them all; List view shows one line each until you
 * open one. Nothing leaves the column until it is answered or dismissed.
 */
function ForYouFeed() {
	useDocumentTitle('For You')
	const { workspaceId } = useWorkspace()
	const queryClient = useQueryClient()
	const { data, isLoading, isError, error, refetch } = useForYou(workspaceId)
	const items = data?.items ?? []
	const markRead = useMarkRead(workspaceId)
	const markUnread = useMarkUnread(workspaceId)

	const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
	const [filterPills, setFilterPills] = useState(false)
	// Cards opened by hand in List view, threads answered in this sitting, and
	// options taken in this sitting.
	const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set())
	const [repliedKeys, setRepliedKeys] = useState<Set<string>>(() => new Set())
	// A taken option marks the thread read, so the server drops it from the
	// unread feed on the next fetch. The card is kept here with the option that
	// was taken so its green receipt stays in place for the sitting, the way the
	// mockup keeps decided cards in the column.
	const [decided, setDecided] = useState<Map<string, { item: UnreadItem; option: DecidedOption }>>(
		() => new Map(),
	)
	// Taking an option is a real write, and the handlers can be reached twice
	// before a render lands (the `···` menu fires onSelect twice for one click;
	// a bulk list is read from the last render). These refs are read in the same
	// tick, so a second call for the same thing is dropped instead of posting again.
	// Decisions are keyed by card and the ask they answer, so a newer ask on the
	// same thread can still be taken. Stack messages hold the call itself, so a
	// repeat joins the one already sent — from the stack or from the card's own bar.
	const decidingRef = useRef<Set<string>>(new Set())
	const draftCallsRef = useRef<Map<string, Promise<unknown>>>(new Map())
	const [bulkConfirm, setBulkConfirm] = useState<UnreadItem[] | null>(null)
	const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set())
	// Cards hidden because the reader typed an answer, keyed to the
	// `latest_event_id` they answered. Unlike `pendingKeys`, this hide ends on
	// its own: a newer mention on the same thread (the agent answering) is
	// activity the reader hasn't seen, so the card has to come back.
	const [answeredAt, setAnsweredAt] = useState<Map<string, number>>(() => new Map())

	// Feed mode (cards/list) is persisted per actor under the `__chrome__`
	// sentinel display-settings row — the same store the object-detail sidebar
	// collapse bit uses. First paint defaults to cards, then reconciles to the
	// persisted `foryouViewMode` once the settings query has fetched.
	const settingsQuery = useUserDisplaySettings(workspaceId, CHROME_KEY)
	const upsertSettings = useUpdateUserDisplaySettings(workspaceId)
	const persistedSettings = settingsQuery.data?.settings
	const mode: FeedMode = settingsQuery.isFetched
		? foryouViewModeToFeedMode(persistedSettings?.foryouViewMode)
		: 'cards'

	// The menu can fire onSelect twice for one click (pointer plus focus
	// activation before the controlled value flushes) and fires even when the
	// chosen mode is already active — both would re-upsert the same setting.
	// Dedupe on the last mode written, and skip outright when the requested
	// mode already matches what's shown.
	const lastWrittenModeRef = useRef<FeedMode | null>(null)
	const handleModeChange = useCallback(
		(next: FeedMode) => {
			if (lastWrittenModeRef.current === next) return
			const current: FeedMode = settingsQuery.isFetched
				? foryouViewModeToFeedMode(persistedSettings?.foryouViewMode)
				: 'cards'
			if (current === next) return
			lastWrittenModeRef.current = next
			const nextSettings: DisplaySettingsBody = {
				...(persistedSettings ?? {}),
				foryouViewMode: feedModeToForyouViewMode(next),
			}
			upsertSettings.mutate(
				{ objectType: CHROME_KEY, settings: nextSettings },
				// On failure the optimistic write rolls back, so clear the
				// dedupe ref and let the user retry the same mode.
				{
					onError: () => {
						lastWrittenModeRef.current = null
					},
				},
			)
		},
		[settingsQuery.isFetched, persistedSettings, upsertSettings],
	)

	const onboardingItems = useMemo(
		() => items.filter((item) => item.object?.type === 'onboarding_session'),
		[items],
	)

	// The Chief of Staff's rank is the order: the server returns the list
	// already sorted, so the feed shows it as given. Onboarding sessions keep
	// their own prompt card above it.
	const sortedRegular = useMemo(
		() => items.filter((item) => item.object?.type !== 'onboarding_session'),
		[items],
	)

	const visibleRegular = useMemo(() => {
		if (pendingKeys.size === 0 && answeredAt.size === 0) return sortedRegular
		return sortedRegular.filter((item) => {
			const key = feedItemKey(item)
			if (pendingKeys.has(key)) return false
			const answered = answeredAt.get(key)
			return answered === undefined || (item.latest_event_id ?? 0) > answered
		})
	}, [sortedRegular, pendingKeys, answeredAt])

	const unreadRegular = useMemo(
		() => visibleRegular.filter((item) => item.unread_count > 0),
		[visibleRegular],
	)

	// Chip counts reflect the unread queue regardless of the active filter, so
	// switching filters never makes the other counts disappear.
	const typeCounts = useMemo(() => {
		const counts = new Map<string, number>()
		for (const item of unreadRegular) {
			const type = item.object?.type
			if (!type) continue
			counts.set(type, (counts.get(type) ?? 0) + 1)
		}
		return counts
	}, [unreadRegular])

	const filteredRegular = useMemo(
		() =>
			typeFilter ? unreadRegular.filter((item) => item.object?.type === typeFilter) : unreadRegular,
		[unreadRegular, typeFilter],
	)

	const bucketOf = useCallback(
		(item: UnreadItem): FeedBucket => {
			const key = feedItemKey(item)
			if (decided.has(key)) return 'done'
			if (repliedKeys.has(key)) return 'waiting'
			return 'needs'
		},
		[decided, repliedKeys],
	)

	// The feed is one flat column ordered by bucket — decisions first, then
	// what is waiting on an agent, then FYIs, then what has been handled. The
	// mockup renders those buckets without headings; the order is the grouping.
	// Cards decided in this sitting are folded back in, since the unread query
	// has already dropped them.
	const orderedCards = useMemo(() => {
		const live = filteredRegular
		const seen = new Set(live.map(feedItemKey))
		const handled = [...decided.values()]
			.map((entry) => entry.item)
			.filter((item) => !seen.has(feedItemKey(item)))
			.filter((item) => !typeFilter || item.object?.type === typeFilter)
		return [...live, ...handled]
			.map((item, index) => ({ item, index }))
			.sort(
				(a, b) => bucketRank(bucketOf(a.item)) - bucketRank(bucketOf(b.item)) || a.index - b.index,
			)
			.map((entry) => entry.item)
	}, [filteredRegular, decided, typeFilter, bucketOf])

	// Posting the reply a taken option stands for. It goes out the moment the
	// option is taken — there is no delete-comment endpoint, so a deferred
	// write with an Undo would only be pretending to be reversible.
	const postReply = useMutation({
		mutationFn: (input: CreateCommentInput) => api.events.create(workspaceId, input),
		onSuccess: (_result, input) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(input.entity_id) })
		},
	})

	// A taken option paints its green receipt before the reply lands, so a
	// failed write has to take the receipt back down — otherwise the card claims
	// an answer was sent that never was.
	const undoDecision = useCallback((key: string) => {
		setDecided((prev) => {
			if (!prev.has(key)) return prev
			const next = new Map(prev)
			next.delete(key)
			return next
		})
	}, [])

	// A card hidden on an optimistic mark-read has to come back the moment the
	// write fails, or the toast's promise that it is still in the feed is a lie
	// — it would sit hidden until some unrelated refetch happened to restore it.
	const restorePending = useCallback((key: string) => {
		setPendingKeys((prev) => {
			if (!prev.has(key)) return prev
			const next = new Set(prev)
			next.delete(key)
			return next
		})
	}, [])

	// Returns whether a mark-read was actually dispatched. An item with no
	// `latest_event_id` has no high-water mark to move, so the request would be
	// meaningless — callers must not hide such a card, or it silently returns
	// on the next refetch.
	//
	// `onFailed` lets a caller put back state that only it knows it took away —
	// un-hiding the card is handled here, but a dismissal that also cleared a
	// decision receipt has to restore that itself, or the card is left in
	// neither `decided` nor the unread list and disappears for good.
	const markItemRead = useCallback(
		(item: UnreadItem, onFailed?: () => void) => {
			const eventId = item.latest_event_id ?? 0
			if (eventId <= 0) return false
			// `mutateAsync`, not `mutate` with an `onError` callback: these hooks
			// hold ONE mutation observer for the whole feed, and every
			// `observer.mutate()` overwrites the previous call's options and
			// detaches its observer. In a bulk loop that means only the LAST
			// item's callback could ever fire, so every earlier failure would
			// roll back nothing and say nothing. The returned promise is
			// per-mutation, so awaiting it keeps each item's handling its own.
			markRead
				.mutateAsync({
					entityType: item.entity_type,
					entityId: item.entity_id,
					lastEventId: eventId,
				})
				.catch(() => {
					restorePending(feedItemKey(item))
					onFailed?.()
					toast.error("Couldn't mark that as read — it's back in your feed.")
				})
			return true
		},
		[markRead, restorePending],
	)

	// Same shared-observer hazard as `markItemRead` — Undo marks a whole batch
	// unread in a loop, so per-call handling has to hang off the promise.
	const markItemUnread = useCallback(
		(item: UnreadItem) => {
			markUnread
				.mutateAsync({ entityType: item.entity_type, entityId: item.entity_id })
				.catch(() => toast.error("Couldn't undo that — the thread stayed read."))
		},
		[markUnread],
	)

	// One message of a stacked card. The reply names the message by the agent's own
	// key, so the agent can tell which one was sent and which was skipped. It goes
	// under the question like any other answer. Rejects when the reply fails, so the
	// card keeps that message open instead of showing it as dealt with. A message
	// already sent or skipped (or on its way) is not posted again: the repeat gets
	// the first call back.
	const handleDraftAction = useCallback(
		(item: UnreadItem, draft: LatestMentionDecisionDraft, action: DraftAction) => {
			const callKey = draftCallKey(item, draft)
			const existing = draftCallsRef.current.get(callKey)
			if (existing) return existing
			const what = [draft.label ?? 'Message', draft.to ? `to ${draft.to}` : null]
				.filter(Boolean)
				.join(' ')
			const approval = action === 'send' ? approveDraft(draft) : Promise.resolve()
			const call = approval.then(() =>
				postReply.mutateAsync({
					entity_id: item.entity_id,
					content: `${action === 'send' ? 'Send' : 'Skip'}: ${what}${draft.id ? ` (${draft.id})` : ''}`,
					...(item.latest_mention ? { parent_event_id: item.latest_mention.event_id } : {}),
				}),
			)
			draftCallsRef.current.set(callKey, call)
			// A failed call must not block the retry.
			call.catch(() => {
				if (draftCallsRef.current.get(callKey) === call) draftCallsRef.current.delete(callKey)
			})
			return call
		},
		[postReply],
	)

	// Taking an option posts the reply and marks the thread read, which drops
	// the card out of the feed on the next fetch. Until then it shows its green
	// receipt in place.
	const handleDecide = useCallback(
		(item: UnreadItem, option: DecidedOption) => {
			const key = feedItemKey(item)
			const decideKey = `${key}:${item.latest_mention?.event_id ?? item.latest_event_id ?? 0}`
			if (decidingRef.current.has(decideKey)) return
			decidingRef.current.add(decideKey)
			setDecided((prev) => new Map(prev).set(key, { item, option }))
			// Choosing the option that sends is the person's approval of the draft behind the
			// card. It is recorded first, bound to the text they saw, so the agent's send
			// tool can check it. A draft that changed since refuses here and the card reopens.
			const decision = item.latest_mention?.decision
			const sends = isSendingOption(item, option.label)
			// A stacked card may already have had messages sent or skipped one by one.
			// The bar then settles the rest the same way, message by message, so one
			// already sent is not told to send again.
			const stacked = decision?.drafts ?? []
			const settleByMessage =
				sends && stacked.some((draft) => draftCallsRef.current.has(draftCallKey(item, draft)))
			const approval = sends ? approveDraft(decision?.draft) : Promise.resolve()
			// `mutateAsync` for the same reason as `markItemRead`: "Take every
			// suggested option" calls this in a loop over one shared observer,
			// and with call-site callbacks every reply but the last would fail
			// silently behind a green receipt claiming it was sent.
			approval
				.then(() =>
					settleByMessage
						? Promise.all(stacked.map((draft) => handleDraftAction(item, draft, 'send')))
						: postReply.mutateAsync({
								entity_id: item.entity_id,
								content: option.label,
								// The answer belongs under the question. Without this it lands as
								// a loose comment on the object, and the agent that asked has to
								// infer from timing which of its asks was just answered.
								...(item.latest_mention ? { parent_event_id: item.latest_mention.event_id } : {}),
							}),
				)
				.then(() => {
					// A thread with no high-water mark can't be marked read, so the
					// reply would go out and the card would come back on the next
					// refetch carrying the reader's own answer. Say so rather than
					// leaving a receipt that implies the thread is settled.
					if (!markItemRead(item)) {
						toast.warning('Reply sent, but the thread stayed unread.')
					}
				})
				.catch(() => {
					decidingRef.current.delete(decideKey)
					undoDecision(key)
					toast.error("Couldn't send your reply — try again.")
				})
		},
		[handleDraftAction, markItemRead, postReply, undoDecision],
	)

	// The last message has been dealt with: the card settles the way a taken option
	// does, but without a further reply, since each message already got its own.
	const handleDraftsDone = useCallback(
		(item: UnreadItem) => {
			setDecided((prev) =>
				new Map(prev).set(feedItemKey(item), {
					item,
					option: { id: 'drafts', label: 'Dealt with every message' },
				}),
			)
			if (!markItemRead(item)) toast.warning('Replies sent, but the thread stayed unread.')
		},
		[markItemRead],
	)

	// Typing an answer settles the thread exactly as taking an option does, so
	// the card has to leave the column the same way. The composer has already
	// posted the comment by the time this fires, so the card is hidden
	// optimistically — but only until the thread has a newer mention than the
	// one answered (`answeredAt`), so the agent's answer to this reply still
	// shows up live.
	const handleReplied = useCallback(
		(item: UnreadItem) => {
			const key = feedItemKey(item)
			setRepliedKeys((prev) => new Set(prev).add(key))
			// A typed reply implies a read — emit here, next to the gesture, so
			// the funnel counts it even if the mark-read call fails.
			trackForyouCardMarkedRead({
				card_kind: classifyCardKind(item),
				card_id: item.entity_id,
			})
			const forget = () => {
				setRepliedKeys((prev) => {
					const next = new Set(prev)
					next.delete(key)
					return next
				})
				setAnsweredAt((prev) => {
					if (!prev.has(key)) return prev
					const next = new Map(prev)
					next.delete(key)
					return next
				})
			}
			// Same honesty as a taken option: an unmarkable thread comes back on
			// the next fetch carrying the reader's own answer, so say so rather
			// than implying it is settled. Only hide the card when the mark-read
			// was actually dispatched — otherwise `forget` on failure has
			// nothing meaningful to un-hide.
			if (markItemRead(item, forget)) {
				setAnsweredAt((prev) => new Map(prev).set(key, item.latest_event_id ?? 0))
			} else {
				forget()
				toast.warning('Reply sent, but the thread stayed unread.')
			}
		},
		[markItemRead],
	)

	// Dismissing is marking read: the high-water mark moves and the card leaves
	// the column. The mutation fires immediately — waiting for the Undo toast to
	// close before mutating meant navigating away during that window silently
	// dropped the mark-read — and Undo reverses it with a real mark-unread.
	// Cards already answered in this sitting go too, receipt and all, so
	// "Dismiss all" always empties what the reader can see.
	const dismissAll = useCallback(
		(targets: UnreadItem[], label: string) => {
			if (targets.length === 0) return
			// Only cards whose mark-read actually went out may be hidden. A card
			// that couldn't be marked stays in the column rather than vanishing
			// and reappearing on the next refetch.
			//
			// A dismissed card that already carried a receipt is cleared out of
			// `decided` below, and the server has already dropped it from unread
			// — so if the mark-read then fails, nothing else would bring it back.
			// Restore its receipt alongside the un-hide.
			const decidedBefore = decided
			const dismissed = targets.filter((item) => {
				const marked = markItemRead(item, () => {
					const key = feedItemKey(item)
					const decision = decidedBefore.get(key)
					if (!decision) return
					setDecided((prev) => (prev.has(key) ? prev : new Map(prev).set(key, decision)))
				})
				// One `foryou_card_marked_read` per successfully-marked item —
				// bulk dismiss is the reader saying "read" for every card that
				// actually leaves the column. Skips items that couldn't be marked
				// so the analytics volume matches what the reader actually cleared.
				if (marked) {
					trackForyouCardMarkedRead({
						card_kind: classifyCardKind(item),
						card_id: item.entity_id,
					})
				}
				return marked
			})
			if (dismissed.length === 0) {
				toast.error("Couldn't dismiss those — they're still in your feed.")
				return
			}
			const keys = new Set(dismissed.map(feedItemKey))
			setPendingKeys((prev) => new Set([...prev, ...keys]))
			// Undo has to put back everything the dismissal took, receipts
			// included — a decided card restored as undecided would re-offer its
			// options and let the reader post the same reply twice.
			const restoredDecisions = [...decided].filter(([key]) => keys.has(key))
			const restoredReplied = [...keys].filter((key) => repliedKeys.has(key))
			setDecided((prev) => {
				if (restoredDecisions.length === 0) return prev
				const next = new Map(prev)
				for (const key of keys) next.delete(key)
				return next
			})

			toast(label, {
				duration: UNDO_WINDOW_MS,
				action: {
					label: 'Undo',
					onClick: () => {
						for (const item of dismissed) markItemUnread(item)
						setPendingKeys((prev) => {
							const next = new Set(prev)
							for (const key of keys) next.delete(key)
							return next
						})
						if (restoredDecisions.length > 0) {
							setDecided((prev) => new Map([...prev, ...restoredDecisions]))
						}
						if (restoredReplied.length > 0) {
							setRepliedKeys((prev) => new Set([...prev, ...restoredReplied]))
						}
					},
				},
			})
		},
		[decided, repliedKeys, markItemRead, markItemUnread],
	)

	// "Take every suggested option" — the recommended answer on every card that
	// still has one open, taken in one go through the same reverse window a
	// single card gets. Only cards where the agent actually named a
	// recommendation: a plain mention has nothing to take, and a decision without
	// one cannot be posted (the API rejects it). An option that sends a message is
	// never part of the bulk path: it is approved on its own card, where the
	// real recipient is visible.
	const openCards = useMemo(
		() =>
			filteredRegular.filter(
				(item) => bucketOf(item) === 'needs' && classifyCardKind(item) !== 'thread',
			),
		[filteredRegular, bucketOf],
	)
	const suggested = useMemo(() => {
		const targets: Array<{
			item: UnreadItem
			option: NonNullable<ReturnType<typeof recommendedAction>>
		}> = []
		let leftOut = 0
		for (const item of openCards) {
			const option = recommendedAction(item)
			if (!option) continue
			if (isSendingOption(item, option.label)) leftOut += 1
			else targets.push({ item, option })
		}
		return { targets, leftOut }
	}, [openCards])

	const takeSuggested = useCallback(() => {
		const confirmed = bulkConfirm ?? []
		setBulkConfirm(null)
		for (const item of confirmed) {
			const option = recommendedAction(item)
			if (!option || isSendingOption(item, option.label) || bucketOf(item) !== 'needs') continue
			handleDecide(item, { id: option.id, label: option.label })
		}
	}, [bulkConfirm, bucketOf, handleDecide])

	const bulkActions: ForYouBulkAction[] = [
		{
			id: 'suggested',
			label: 'Take every suggested option',
			count: suggested.targets.length,
			onSelect: () => {
				if (suggested.targets.length > 0) setBulkConfirm(suggested.targets.map((t) => t.item))
			},
		},
		{
			id: 'all',
			label: 'Dismiss all',
			count: orderedCards.length,
			onSelect: () => dismissAll(orderedCards, 'All caught up'),
		},
	]

	// Alt+U mirrors the `···` menu's "Dismiss all" — power-user keyboard access
	// alongside the click target.
	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isMarkAllReadShortcut(event)) return
			event.preventDefault()
			dismissAll(orderedCards, 'All caught up')
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [dismissAll, orderedCards])

	if (isLoading) {
		return (
			<div className="flex flex-1 min-w-0 flex-col space-y-4" data-testid="foryou-feed-root">
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</div>
		)
	}

	// A failed unread fetch must never fall through to the empty-feed tail —
	// "Feed cleared" would tell the reader nothing is waiting when the feed
	// simply didn't load.
	if (isError) {
		return (
			<div className="flex flex-1 min-w-0 flex-col" data-testid="foryou-feed-root">
				<QueryStateError
					title="Couldn't load your feed"
					error={error instanceof Error ? error : new Error('Unknown error')}
					onRetry={() => refetch()}
				/>
			</div>
		)
	}

	// The tail rule closes an *empty* column — it says why there is nothing to
	// read. With cards on the page it is noise, so it isn't drawn at all.
	const feedIsEmpty = orderedCards.length === 0 && onboardingItems.length === 0
	const tail = feedIsEmpty ? feedTailLabel({ filtered: Boolean(typeFilter) }) : null

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-testid="foryou-feed-root">
			<PageHeader
				title="For you"
				subtitle={
					unreadRegular.length === 0
						? 'All caught up'
						: `${unreadRegular.length} ${unreadRegular.length === 1 ? 'needs' : 'need'} you`
				}
				scrollLocked
			/>

			<ForYouHeader
				unreadCount={unreadRegular.length}
				typeFilter={typeFilter}
				onTypeFilterChange={setTypeFilter}
				typeCounts={typeCounts}
				mode={mode}
				onModeChange={handleModeChange}
				filterPills={filterPills}
				onFilterPillsChange={setFilterPills}
				bulkActions={bulkActions}
			/>

			{bulkConfirm && (
				<TakeSuggestedDialog
					targets={bulkConfirm.flatMap((item) => {
						const option = recommendedAction(item)
						return option
							? [{ key: feedItemKey(item), title: cardHeadline(item), optionLabel: option.label }]
							: []
					})}
					leftOut={suggested.leftOut}
					onConfirm={takeSuggested}
					onCancel={() => setBulkConfirm(null)}
				/>
			)}

			<div className="-ml-1 min-h-0 w-[calc(100%+0.25rem)] flex-1 overflow-y-auto px-1 pb-14">
				<div className="mx-auto flex w-full max-w-[700px] flex-col">
					<BriefingRow workspaceId={workspaceId} />

					{onboardingItems.length > 0 && (
						<div className="mt-3 space-y-3">
							{onboardingItems.map((item) => (
								<OnboardingPromptCard
									key={feedItemKey(item)}
									workspaceId={workspaceId}
									item={item}
								/>
							))}
						</div>
					)}

					<div className={cn('flex flex-col', mode === 'cards' ? 'gap-3' : 'gap-[7px]')}>
						<div className="h-1.5" />
						{orderedCards.map((item) => {
							const key = feedItemKey(item)
							return (
								<FeedCard
									key={key}
									workspaceId={workspaceId}
									item={item}
									expanded={mode === 'cards' || openKeys.has(key)}
									onToggleExpanded={
										mode === 'cards'
											? undefined
											: () =>
													setOpenKeys((prev) => {
														const next = new Set(prev)
														if (next.has(key)) next.delete(key)
														else next.add(key)
														return next
													})
									}
									decided={decided.get(key)?.option ?? null}
									onDecide={(option) => handleDecide(item, option)}
									onDraftAction={(draft, action) => handleDraftAction(item, draft, action)}
									onDraftsDone={() => handleDraftsDone(item)}
									replied={repliedKeys.has(key)}
									onReplied={() => handleReplied(item)}
									onMarkRead={() => dismissAll([item], 'Marked as read')}
								/>
							)
						})}
					</div>

					{tail && (
						<div className="flex items-center justify-center gap-2 pb-2.5 pt-[34px] text-[11.5px] text-muted-foreground">
							<span className="h-px w-10 bg-border" />
							{tail}
							<span className="h-px w-10 bg-border" />
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

// One message of a stacked card, per ask: the key the stack and the card's own bar share.
function draftCallKey(item: UnreadItem, draft: LatestMentionDecisionDraft): string {
	const ask = item.latest_mention?.event_id ?? item.latest_event_id ?? 0
	return `${feedItemKey(item)}:${ask}:${draft.id ?? draft.object_id ?? draft.label ?? draft.to ?? ''}`
}

// Records the person's approval of the object behind a draft, bound to the text the card
// showed. A draft without a preview (plain text on the card) has nothing to approve and
// resolves at once; the reply to the agent is what carries the decision for those.
function approveDraft(draft: LatestMentionDecisionDraft | undefined): Promise<unknown> {
	if (!draft?.preview || !draft.object_id) return Promise.resolve()
	return api.objects.approve(draft.object_id, draft.preview.content_hash)
}

// Shared keydown guard for the `Alt+U` For You bulk-dismiss shortcut. Alt on
// PC == Option on Mac; ignores keystrokes inside inputs/textareas/contenteditable
// so it never hijacks typing.
export function isMarkAllReadShortcut(event: KeyboardEvent): boolean {
	if (!event.altKey) return false
	if (event.metaKey || event.ctrlKey) return false
	// event.key on Alt-modified keys can be 'u', 'U', or a dead-key composition
	// (e.g. macOS emits '¨' for Option+U); event.code is layout-independent.
	if (event.code !== 'KeyU') return false
	const target = event.target
	if (target instanceof HTMLInputElement) return false
	if (target instanceof HTMLTextAreaElement) return false
	if (target instanceof HTMLSelectElement) return false
	if (target instanceof HTMLElement) {
		if (target.isContentEditable) return false
		const editable = target.getAttribute('contenteditable')
		if (editable === '' || editable === 'true' || editable === 'plaintext-only') {
			return false
		}
	}
	return true
}
