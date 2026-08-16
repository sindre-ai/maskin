import { ForYouCardQueue } from '@/components/foryou/foryou-card-queue'
import {
	type FeedMode,
	type FeedSort,
	ForYouHeader,
	ForYouHeaderActions,
	ForYouHeaderIdentity,
} from '@/components/foryou/foryou-header'
import { ForYouListRow } from '@/components/foryou/foryou-list-row'
import { NewConversationComposer } from '@/components/foryou/new-conversation-composer'
import { NorthStarPromptCard } from '@/components/foryou/north-star-prompt-card'
import { OnboardingPromptCard } from '@/components/foryou/onboarding-prompt-card'
import { SparseComposer } from '@/components/foryou/sparse-composer'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useBets } from '@/hooks/use-bets'
import { useMarkRead, useMarkUnread, useUnread } from '@/hooks/use-subscriptions'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import type { DisplaySettingsBody, UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useNewConversationComposer } from '@/lib/new-conversation-context'
import { useWorkspace } from '@/lib/workspace-context'
import { CHROME_KEY } from '@maskin/shared'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouRedesign,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const UNDO_WINDOW_MS = 15_000

function itemKey(item: UnreadItem): string {
	return `${item.entity_type}:${item.entity_id}`
}

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

function ForYouRedesign() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useUnread(workspaceId, undefined, true)
	const { data: bets, isLoading: betsLoading } = useBets(workspaceId)
	const items = data?.items ?? []
	const markRead = useMarkRead(workspaceId)
	const markUnread = useMarkUnread(workspaceId)
	const { open: composerOpen, setOpen: setComposerOpen } = useNewConversationComposer()

	const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
	const [sort, setSort] = useState<FeedSort>('priority')

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

	// Radix Tabs can fire onValueChange twice for one click on an inactive tab
	// (mousedown activation plus focus activation before the controlled value
	// flushes) and fires even when the clicked tab is already active — both
	// cases would re-upsert the same setting. Dedupe on the last mode written,
	// and skip outright when the requested mode already matches what's shown.
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

	const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set())

	const [northStarDismissed, setNorthStarDismissed] = useState(() =>
		Boolean(localStorage.getItem(`north_star_answered_${workspaceId}`)),
	)
	// Hidden while the sparse composer has focus so it doesn't compete with the
	// composer for vertical space once the on-screen keyboard is up on mobile.
	const [composerFocused, setComposerFocused] = useState(false)

	const onboardingItems = useMemo(
		() => items.filter((item) => item.object?.type === 'onboarding_session'),
		[items],
	)

	// `priority` (default) sorts by the sender's attention score (1-5) on each
	// card's highest-scored unread comment, highest first; unscored comments
	// sort below any scored one. Ties (including all-unscored) fall back to
	// latest_activity_at desc. `latest` is a straight latest_activity_at desc —
	// the alternative surfaced by the sort control per the design directions
	// task.
	const sortedRegular = useMemo(() => {
		const base = items.filter((item) => item.object?.type !== 'onboarding_session')
		const byLatestDesc = (a: UnreadItem, b: UnreadItem) => {
			const at = a.latest_activity_at ? new Date(a.latest_activity_at).getTime() : 0
			const bt = b.latest_activity_at ? new Date(b.latest_activity_at).getTime() : 0
			return bt - at
		}
		if (sort === 'latest') {
			return base.slice().sort(byLatestDesc)
		}
		return base.slice().sort((a, b) => {
			const aAttention = a.max_unread_attention ?? -1
			const bAttention = b.max_unread_attention ?? -1
			if (aAttention !== bAttention) return bAttention - aAttention
			return byLatestDesc(a, b)
		})
	}, [items, sort])

	const visibleRegular = useMemo(() => {
		if (pendingKeys.size === 0) return sortedRegular
		return sortedRegular.filter((item) => !pendingKeys.has(itemKey(item)))
	}, [sortedRegular, pendingKeys])

	const unreadRegular = useMemo(
		() => visibleRegular.filter((item) => item.unread_count > 0),
		[visibleRegular],
	)

	const mentionCount = useMemo(
		() => unreadRegular.filter((item) => item.mentioning_unread_count > 0).length,
		[unreadRegular],
	)

	// Chip counts reflect the unread queue regardless of the active filter, so
	// switching chips never makes the other counts disappear.
	const typeCounts = useMemo(() => {
		const counts = new Map<string, number>()
		for (const item of unreadRegular) {
			const type = item.object?.type
			if (!type) continue
			counts.set(type, (counts.get(type) ?? 0) + 1)
		}
		return counts
	}, [unreadRegular])

	const filteredRegular = useMemo(() => {
		if (typeFilter === 'mentions') {
			return visibleRegular.filter((item) => item.mentioning_unread_count > 0)
		}
		if (typeFilter) return visibleRegular.filter((item) => item.object?.type === typeFilter)
		return visibleRegular
	}, [visibleRegular, typeFilter])

	// The swipeable queue only ever shows unread items — read items lingering
	// in `filteredRegular` (kept around so a reverse-swipe has a target) are
	// excluded here, not from the List-mode row list above.
	const queue = useMemo(
		() => filteredRegular.filter((item) => item.unread_count > 0),
		[filteredRegular],
	)

	const markItemRead = useCallback(
		(item: UnreadItem) => {
			const eventId = item.latest_event_id ?? 0
			if (eventId <= 0) return
			markRead.mutate({
				entityType: item.entity_type,
				entityId: item.entity_id,
				lastEventId: eventId,
			})
		},
		[markRead],
	)

	const markItemUnread = useCallback(
		(item: UnreadItem) => {
			markUnread.mutate({ entityType: item.entity_type, entityId: item.entity_id })
		},
		[markUnread],
	)

	// Fires the real mark-read mutation for every item immediately — it used
	// to wait for the Undo toast to auto-close (or be dismissed) before
	// mutating at all, so navigating away or refreshing during that window
	// silently dropped the mark-read and the items reappeared unread on
	// reload. Undo now reverses the already-landed mutation with a real
	// mark-unread call instead of just restoring the optimistic hide.
	const handleMarkAllRead = useCallback(() => {
		if (visibleRegular.length === 0) return
		const snapshot = visibleRegular
		const snapshotKeys = new Set(snapshot.map(itemKey))
		setPendingKeys((prev) => new Set([...prev, ...snapshotKeys]))

		for (const item of snapshot) markItemRead(item)

		const restore = () => {
			for (const item of snapshot) markItemUnread(item)
			setPendingKeys((prev) => {
				const next = new Set(prev)
				for (const key of snapshotKeys) next.delete(key)
				return next
			})
		}

		const count = snapshot.length
		toast(`Marked ${count} thread${count === 1 ? '' : 's'} as read`, {
			duration: UNDO_WINDOW_MS,
			action: { label: 'Undo', onClick: restore },
		})
	}, [markItemRead, markItemUnread, visibleRegular])

	// Alt+U shortcut mirrors the visible "Mark all read" button in
	// ForYouHeaderActions — power-user keyboard access alongside the click target.
	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isMarkAllReadShortcut(event)) return
			event.preventDefault()
			handleMarkAllRead()
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [handleMarkAllRead])

	const composer = (
		<NewConversationComposer
			workspaceId={workspaceId}
			open={composerOpen}
			onOpenChange={setComposerOpen}
		/>
	)

	if (isLoading || betsLoading) {
		return (
			<div className="flex flex-1 min-w-0 flex-col space-y-4" data-testid="foryou-redesign-root">
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</div>
		)
	}

	const showNorthStarPrompt = (bets?.length ?? 0) === 0 && !northStarDismissed
	const northStarCard =
		showNorthStarPrompt && !composerFocused ? (
			<NorthStarPromptCard
				workspaceId={workspaceId}
				onDismiss={() => setNorthStarDismissed(true)}
			/>
		) : null

	const isSparse = filteredRegular.length + onboardingItems.length < 3
	const sparseComposerNode = isSparse ? (
		<SparseComposer
			itemsCount={filteredRegular.length + onboardingItems.length}
			onFocusChange={setComposerFocused}
		/>
	) : null

	return (
		<>
			<div
				className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
				data-testid="foryou-redesign-root"
			>
				<PageHeader
					stickyIdentity={<ForYouHeaderIdentity unreadCount={unreadRegular.length} />}
					actions={
						<ForYouHeaderActions
							onStartConversation={() => setComposerOpen(true)}
							onMarkAllRead={handleMarkAllRead}
							markAllReadDisabled={unreadRegular.length === 0}
						/>
					}
					scrollLocked={mode === 'cards'}
				/>
				{northStarCard}
				<ForYouHeader
					unreadCount={unreadRegular.length}
					typeFilter={typeFilter}
					onTypeFilterChange={setTypeFilter}
					typeCounts={typeCounts}
					mentionCount={mentionCount}
					mode={mode}
					onModeChange={handleModeChange}
					sort={sort}
					onSortChange={setSort}
				/>

				<div className="flex flex-1 min-h-0 flex-col">
					{onboardingItems.length > 0 && (
						<div className="mb-3 space-y-3">
							{onboardingItems.map((item) => (
								<OnboardingPromptCard
									key={`${item.entity_type}-${item.entity_id}`}
									workspaceId={workspaceId}
									item={item}
								/>
							))}
						</div>
					)}
					{mode === 'list' ? (
						<div className="border-t border-border">
							{filteredRegular.map((item) => (
								<ForYouListRow
									key={`${item.entity_type}-${item.entity_id}`}
									workspaceId={workspaceId}
									item={item}
								/>
							))}
						</div>
					) : (
						<ForYouCardQueue
							workspaceId={workspaceId}
							queue={queue}
							sparseComposer={sparseComposerNode}
						/>
					)}
					{mode === 'list' && typeFilter === 'mentions' && filteredRegular.length === 0 && (
						<p className="py-10 text-center text-sm text-muted-foreground">No unread mentions.</p>
					)}
					{mode === 'list' && sparseComposerNode ? (
						<div className="mt-4">{sparseComposerNode}</div>
					) : null}
				</div>
			</div>
			{composer}
		</>
	)
}

// Shared keydown guard for the `Alt+U` For You bulk-mark-read shortcut. Alt on
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
