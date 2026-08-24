import { BriefCard } from '@/components/foryou/brief-card'
import { type DecidedOption, FeedCard } from '@/components/foryou/feed-card'
import {
	type FeedMode,
	type FeedSort,
	type ForYouBulkAction,
	ForYouHeader,
} from '@/components/foryou/foryou-header'
import { LegacyForYouPage } from '@/components/foryou/legacy/foryou-page'
import { OnboardingPromptCard } from '@/components/foryou/onboarding-prompt-card'
import { ReleaseCard } from '@/components/foryou/release-card'
import { PageHeader } from '@/components/layout/page-header'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { useMarkRead, useMarkUnread, useUnread } from '@/hooks/use-subscriptions'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { type CreateCommentInput, type DisplaySettingsBody, type UnreadItem, api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { CARD_ACTIONS, classifyCardKind } from '@/lib/foryou-card-kind'
import { type FeedBucket, bucketRank, feedItemKey, feedTailLabel } from '@/lib/foryou-feed'
import { useNewDesign } from '@/lib/new-design-context'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { CHROME_KEY } from '@maskin/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

// The single `new-design` boundary for the For You feed: the v4 feed (brief
// card, one card per unread thread) below, or the pre-v2 feed under
// `components/foryou/legacy/`. Reads the resolved flag from `NewDesignProvider`
// rather than calling `useFeatureFlag` again — see
// `.claude/rules/feature-flags.md`.
function ForYouRoute() {
	return useNewDesign() ? <ForYouFeed /> : <LegacyForYouPage />
}

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
 * A single scrolling column: today's brief, then every unread thread as a
 * card. Cards view expands them all; List view shows one line each until you
 * open one. Nothing leaves the column until it is answered or dismissed.
 */
function ForYouFeed() {
	const { workspaceId } = useWorkspace()
	const queryClient = useQueryClient()
	const { data, isLoading, isError, error, refetch } = useUnread(workspaceId, undefined, true)
	const items = data?.items ?? []
	const markRead = useMarkRead(workspaceId)
	const markUnread = useMarkUnread(workspaceId)

	const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
	const [sort, setSort] = useState<FeedSort>('attention')
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
	const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set())

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

	// `attention` (default) sorts by the sender's attention score (1-5) on each
	// card's highest-scored unread comment, highest first; unscored comments
	// sort below any scored one. Ties fall back to latest activity.
	// `chrono` is a straight latest-activity-first ordering.
	const sortedRegular = useMemo(() => {
		const base = items.filter((item) => item.object?.type !== 'onboarding_session')
		const byLatestDesc = (a: UnreadItem, b: UnreadItem) => {
			const at = a.latest_activity_at ? new Date(a.latest_activity_at).getTime() : 0
			const bt = b.latest_activity_at ? new Date(b.latest_activity_at).getTime() : 0
			return bt - at
		}
		if (sort === 'chrono') return base.slice().sort(byLatestDesc)
		return base.slice().sort((a, b) => {
			const aAttention = a.max_unread_attention ?? -1
			const bAttention = b.max_unread_attention ?? -1
			if (aAttention !== bAttention) return bAttention - aAttention
			return byLatestDesc(a, b)
		})
	}, [items, sort])

	const visibleRegular = useMemo(() => {
		if (pendingKeys.size === 0) return sortedRegular
		return sortedRegular.filter((item) => !pendingKeys.has(feedItemKey(item)))
	}, [sortedRegular, pendingKeys])

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
			return classifyCardKind(item) === 'thread' ? 'fyi' : 'needs'
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

	// Taking an option posts the reply and marks the thread read, which drops
	// the card out of the feed on the next fetch. Until then it shows its green
	// receipt in place.
	const handleDecide = useCallback(
		(item: UnreadItem, option: DecidedOption) => {
			const key = feedItemKey(item)
			setDecided((prev) => new Map(prev).set(key, { item, option }))
			// `mutateAsync` for the same reason as `markItemRead`: "Take every
			// suggested option" calls this in a loop over one shared observer,
			// and with call-site callbacks every reply but the last would fail
			// silently behind a green receipt claiming it was sent.
			postReply
				.mutateAsync({ entity_id: item.entity_id, content: option.label })
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
					undoDecision(key)
					toast.error("Couldn't send your reply — try again.")
				})
		},
		[markItemRead, postReply, undoDecision],
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
			const dismissed = targets.filter((item) =>
				markItemRead(item, () => {
					const key = feedItemKey(item)
					const decision = decidedBefore.get(key)
					if (!decision) return
					setDecided((prev) => (prev.has(key) ? prev : new Map(prev).set(key, decision)))
				}),
			)
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
	// single card gets.
	const takeSuggested = useCallback(
		(targets: UnreadItem[]) => {
			for (const item of targets) {
				const kind = classifyCardKind(item)
				if (kind === 'thread') continue
				const option =
					CARD_ACTIONS[kind].find((action) => action.recommended) ?? CARD_ACTIONS[kind][0]
				if (!option) continue
				handleDecide(item, { id: option.id, label: option.label })
			}
		},
		[handleDecide],
	)

	const openCards = useMemo(
		() =>
			filteredRegular.filter(
				(item) => bucketOf(item) === 'needs' && classifyCardKind(item) !== 'thread',
			),
		[filteredRegular, bucketOf],
	)
	const fyiCards = useMemo(
		() => filteredRegular.filter((item) => bucketOf(item) === 'fyi'),
		[filteredRegular, bucketOf],
	)

	const bulkActions: ForYouBulkAction[] = [
		{
			id: 'fyi',
			label: 'Dismiss all FYIs',
			count: fyiCards.length,
			onSelect: () => dismissAll(fyiCards, 'FYIs cleared'),
		},
		{
			id: 'suggested',
			label: 'Take every suggested option',
			count: openCards.length,
			onSelect: () => takeSuggested(openCards),
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
				subtitle={unreadRegular.length === 0 ? 'All caught up' : `${unreadRegular.length} unread`}
				scrollLocked
			/>

			<ForYouHeader
				unreadCount={unreadRegular.length}
				typeFilter={typeFilter}
				onTypeFilterChange={setTypeFilter}
				typeCounts={typeCounts}
				mode={mode}
				onModeChange={handleModeChange}
				sort={sort}
				onSortChange={setSort}
				filterPills={filterPills}
				onFilterPillsChange={setFilterPills}
				bulkActions={bulkActions}
			/>

			<div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-14">
				<div className="mx-auto flex w-full max-w-[700px] flex-col">
					<BriefCard workspaceId={workspaceId} />
					<ReleaseCard />

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
									replied={repliedKeys.has(key)}
									onReplied={() => setRepliedKeys((prev) => new Set(prev).add(key))}
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
