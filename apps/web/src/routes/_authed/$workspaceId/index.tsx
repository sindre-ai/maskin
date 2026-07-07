import { NewConversationComposer } from '@/components/foryou/new-conversation-composer'
import { OnboardingPromptCard } from '@/components/foryou/onboarding-prompt-card'
import { PersistentReplyBar } from '@/components/foryou/persistent-reply-bar'
import { SparseComposer } from '@/components/foryou/sparse-composer'
import { UnreadThreadCard } from '@/components/foryou/unread-thread-card'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useMarkRead, useUnread } from '@/hooks/use-subscriptions'
import type { UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useNewConversationComposer } from '@/lib/new-conversation-context'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const UNDO_WINDOW_MS = 15_000

function itemKey(item: UnreadItem): string {
	return `${item.entity_type}:${item.entity_id}`
}

function ForYouDashboard() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { data, isLoading } = useUnread(workspaceId)
	const items = data?.items ?? []
	const markRead = useMarkRead(workspaceId)

	const [activeId, setActiveId] = useState<string | null>(null)
	const [activeReplyTarget, setActiveReplyTarget] = useState<number | null>(null)
	const { open: composerOpen, setOpen: setComposerOpen } = useNewConversationComposer()

	// Items currently hidden by an in-flight "Mark all as read" toast. Kept in
	// component state (rather than mutated into the useUnread cache) so SSE
	// arrivals during the undo window still land in the feed and the snapshot
	// stays a clean rollback target.
	const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set())
	// Guard so onDismiss + onAutoClose can't double-commit or double-restore.
	const settledRef = useRef(false)

	// Onboarding sessions render as their own prompt card above the thread stream
	// and aren't part of the unread thread stream, so mark-all-read never touches them.
	const onboardingItems = useMemo(
		() => items.filter((item) => item.object?.type === 'onboarding_session'),
		[items],
	)

	// Regular threads, with mentioning_unread_count items ("Needs your input") sorted before FYI
	// items; stable within each tier.
	const sortedRegular = useMemo(
		() =>
			items
				.filter((item) => item.object?.type !== 'onboarding_session')
				.sort((a, b) => {
					const aMentions = a.mentioning_unread_count > 0
					const bMentions = b.mentioning_unread_count > 0
					if (aMentions && !bMentions) return -1
					if (!aMentions && bMentions) return 1
					return 0
				}),
		[items],
	)

	const visibleRegular = useMemo(() => {
		if (pendingKeys.size === 0) return sortedRegular
		return sortedRegular.filter((item) => !pendingKeys.has(itemKey(item)))
	}, [sortedRegular, pendingKeys])

	const activeItem = useMemo(
		() => (activeId ? items.find((item) => item.entity_id === activeId) : null),
		[activeId, items],
	)

	// If the active card's item drops out of the feed (e.g. a quick-reply chip's
	// own mark-read call zeroes its unread_count, so it's no longer rendered),
	// clear the selection — otherwise the reply bar keeps showing "Replying to:
	// Untitled" for a card that isn't on the page anymore.
	useEffect(() => {
		if (activeId && !activeItem) {
			setActiveId(null)
			setActiveReplyTarget(null)
		}
	}, [activeId, activeItem])

	// Advance the read high-water-mark for a single unread item, using the
	// server's authoritative latest_event_id.
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

	const totalUnread = items.reduce((sum, item) => sum + (item.unread_count ?? 0), 0)

	// Optimistically hides the visible regular threads, then commits the mutations
	// (one per thread — non-batched by design, typical inboxes are small and a
	// batch endpoint doesn't exist yet) after the undo window closes. Onboarding
	// prompts render as their own card and are excluded from the snapshot.
	const handleMarkAllRead = useCallback(() => {
		if (visibleRegular.length === 0) return
		const snapshot = visibleRegular
		const snapshotKeys = new Set(snapshot.map(itemKey))
		settledRef.current = false
		setPendingKeys((prev) => new Set([...prev, ...snapshotKeys]))

		const commit = () => {
			if (settledRef.current) return
			settledRef.current = true
			for (const item of snapshot) {
				markItemRead(item)
			}
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

	// Alt+U (Option+U on macOS) triggers the bulk action. Guarded so typing
	// into inputs/textareas/contenteditable never fires it — Linear convention.
	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isMarkAllReadShortcut(event)) return
			event.preventDefault()
			handleMarkAllRead()
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [handleMarkAllRead])

	if (isLoading) {
		return (
			<div className="space-y-4">
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</div>
		)
	}

	const composer = (
		<NewConversationComposer
			workspaceId={workspaceId}
			open={composerOpen}
			onOpenChange={setComposerOpen}
		/>
	)

	const isSparse = visibleRegular.length + onboardingItems.length < 3

	if (items.length === 0) {
		return (
			<>
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-end">
						<Button
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={() => setComposerOpen(true)}
							aria-label="New conversation"
						>
							<Plus size={12} className="mr-1" aria-hidden />
							New
						</Button>
					</div>
					<EmptyState
						title="All caught up"
						description="New comments and replies on things you're subscribed to will appear here."
						action={
							<Button
								size="sm"
								onClick={() =>
									navigate({
										to: '/$workspaceId/objects',
										params: { workspaceId },
										search: {
											type: undefined,
											status: undefined,
											driver: undefined,
											sort: 'createdAt',
											order: 'desc',
											q: undefined,
											groupBy: undefined,
											ids: undefined,
										},
									})
								}
							>
								Browse objects
							</Button>
						}
						className="py-2 md:py-8"
						compact
					/>
					<SparseComposer itemsCount={0} />
				</div>
				{composer}
			</>
		)
	}

	return (
		<>
			<div className={cn('flex flex-col gap-4', activeId && 'pb-28')}>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium text-foreground">For You</span>
						{totalUnread > 0 && (
							<span className="min-w-[18px] rounded-full bg-foreground px-1.5 py-0.5 text-center text-[10px] font-semibold text-background">
								{totalUnread}
							</span>
						)}
					</div>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs min-h-[44px] sm:min-h-0"
							onClick={handleMarkAllRead}
							disabled={visibleRegular.length === 0}
							title="Mark all as read (Alt+U)"
						>
							Mark all as read ({visibleRegular.length})
						</Button>
						<Button
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={() => setComposerOpen(true)}
							aria-label="New conversation"
						>
							<Plus size={12} className="mr-1" aria-hidden />
							New
						</Button>
					</div>
				</div>
				<div className="space-y-4">
					{onboardingItems.map((item) => (
						<OnboardingPromptCard
							key={`${item.entity_type}-${item.entity_id}`}
							workspaceId={workspaceId}
							item={item}
						/>
					))}
					{visibleRegular.map((item) => (
						<UnreadThreadCard
							key={`${item.entity_type}-${item.entity_id}`}
							workspaceId={workspaceId}
							item={item}
							isActive={activeId === item.entity_id}
							onActivate={() => {
								setActiveId(item.entity_id)
								setActiveReplyTarget(null)
							}}
							onReplyTargetChange={setActiveReplyTarget}
						/>
					))}
					{isSparse ? (
						<SparseComposer itemsCount={visibleRegular.length + onboardingItems.length} />
					) : null}
				</div>
			</div>
			<PersistentReplyBar
				workspaceId={workspaceId}
				activeId={activeId}
				activeTitle={activeItem?.object?.title ?? null}
				parentEventId={activeReplyTarget}
				onClear={() => {
					setActiveId(null)
					setActiveReplyTarget(null)
				}}
				onSent={() => {
					if (activeItem) markItemRead(activeItem)
				}}
			/>
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
