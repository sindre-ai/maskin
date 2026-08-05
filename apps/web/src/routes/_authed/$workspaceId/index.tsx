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
import { EmptyState } from '@/components/shared/empty-state'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useBets } from '@/hooks/use-bets'
import { useCreateObject } from '@/hooks/use-objects'
import { useMarkRead, useUnread } from '@/hooks/use-subscriptions'
import type { UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { PageHeader } from '@/components/layout/page-header'
import { useNewConversationComposer } from '@/lib/new-conversation-context'
import { useWorkspace } from '@/lib/workspace-context'
import { getDefaultStatusForType } from '@maskin/module-sdk'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
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

function ForYouRedesign() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { data, isLoading } = useUnread(workspaceId, undefined, true)
	const { data: bets, isLoading: betsLoading } = useBets(workspaceId)
	const items = data?.items ?? []
	const markRead = useMarkRead(workspaceId)
	const { open: composerOpen, setOpen: setComposerOpen } = useNewConversationComposer()

	const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
	const [mode, setMode] = useState<FeedMode>('cards')
	const [sort, setSort] = useState<FeedSort>('priority')

	const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set())
	const settledRef = useRef(false)

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

	// `priority` (default) puts mentions above FYI, stable within tiers.
	// `latest` is a straight latest_activity_at desc — the alternative surfaced
	// by the sort control per the design directions task.
	const sortedRegular = useMemo(() => {
		const base = items.filter((item) => item.object?.type !== 'onboarding_session')
		if (sort === 'latest') {
			return base.slice().sort((a, b) => {
				const at = a.latest_activity_at ? new Date(a.latest_activity_at).getTime() : 0
				const bt = b.latest_activity_at ? new Date(b.latest_activity_at).getTime() : 0
				return bt - at
			})
		}
		return base.slice().sort((a, b) => {
			const aMentions = a.mentioning_unread_count > 0
			const bMentions = b.mentioning_unread_count > 0
			if (aMentions && !bMentions) return -1
			if (!aMentions && bMentions) return 1
			return 0
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

	const handleMarkAllRead = useCallback(() => {
		if (visibleRegular.length === 0) return
		const snapshot = visibleRegular
		const snapshotKeys = new Set(snapshot.map(itemKey))
		settledRef.current = false
		setPendingKeys((prev) => new Set([...prev, ...snapshotKeys]))

		const commit = () => {
			if (settledRef.current) return
			settledRef.current = true
			for (const item of snapshot) markItemRead(item)
			setPendingKeys((prev) => {
				const next = new Set(prev)
				for (const key of snapshotKeys) next.delete(key)
				return next
			})
		}
		const restore = () => {
			if (settledRef.current) return
			settledRef.current = true
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
			onAutoClose: commit,
			onDismiss: commit,
		})
	}, [markItemRead, visibleRegular])

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

	// +New dropdown creates a bet/insight/task without navigating away — the
	// toast is the affordance to jump into the new object if the user wants to
	// edit further. Status seed uses the module SDK's per-type default; the
	// per-workspace override is the concern of the object detail bootstrap and
	// is intentionally out of scope for this shortcut.
	const createObject = useCreateObject(workspaceId)
	const handleCreateObject = useCallback(
		(type: 'bet' | 'insight' | 'task') => {
			const label =
				type === 'bet' ? 'Untitled bet' : type === 'insight' ? 'Untitled insight' : 'Untitled task'
			createObject.mutate(
				{ type, title: label, status: getDefaultStatusForType(type) ?? 'new' },
				{
					onSuccess: (created) => {
						toast(`${label} created`, {
							action: {
								label: 'Open',
								onClick: () =>
									navigate({
										to: '/$workspaceId/objects/$objectId',
										params: { workspaceId, objectId: created.id },
									}).catch(() => {}),
							},
						})
					},
					onError: (err) => {
						toast.error(err instanceof Error ? err.message : `Failed to create ${type}`)
					},
				},
			)
		},
		[createObject, navigate, workspaceId],
	)

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

	return (
		<>
			<div className="flex min-w-0 flex-1 flex-col gap-3" data-testid="foryou-redesign-root">
				<PageHeader
					stickyIdentity={<ForYouHeaderIdentity unreadCount={unreadRegular.length} />}
					actions={
						<ForYouHeaderActions
							onStartConversation={() => setComposerOpen(true)}
							onCreateObject={handleCreateObject}
							onMarkAllRead={handleMarkAllRead}
							markAllReadDisabled={unreadRegular.length === 0}
						/>
					}
				/>
				{northStarCard}
				<ForYouHeader
					unreadCount={unreadRegular.length}
					typeFilter={typeFilter}
					onTypeFilterChange={setTypeFilter}
					typeCounts={typeCounts}
					mentionCount={mentionCount}
					mode={mode}
					onModeChange={setMode}
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
						<ForYouCardQueue workspaceId={workspaceId} queue={queue} />
					)}
					{mode === 'list' && typeFilter === 'mentions' && filteredRegular.length === 0 && (
						<p className="py-10 text-center text-sm text-muted-foreground">No unread mentions.</p>
					)}
					{isSparse ? (
						<div className="mt-4">
							<SparseComposer
								itemsCount={filteredRegular.length + onboardingItems.length}
								onFocusChange={setComposerFocused}
							/>
						</div>
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
