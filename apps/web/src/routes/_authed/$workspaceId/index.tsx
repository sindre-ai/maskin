import { OnboardingPromptCard } from '@/components/foryou/onboarding-prompt-card'
import { SparseComposer } from '@/components/foryou/sparse-composer'
import { UnreadThreadCard } from '@/components/foryou/unread-thread-card'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useMarkRead, useUnread } from '@/hooks/use-subscriptions'
import type { UnreadItem } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
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
	const { data, isLoading } = useUnread(workspaceId)
	const items = data?.items ?? []
	const markRead = useMarkRead(workspaceId)

	// Items currently hidden by an in-flight "Mark all as read" toast. Kept in
	// component state (rather than mutated into the useUnread cache) so SSE
	// arrivals during the undo window still land in the feed and the snapshot
	// stays a clean rollback target.
	const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set())
	// Guard so onDismiss + onAutoClose can't double-commit or double-restore.
	const settledRef = useRef(false)

	const visibleItems = useMemo(() => {
		if (pendingKeys.size === 0) return items
		return items.filter((item) => !pendingKeys.has(itemKey(item)))
	}, [items, pendingKeys])

	const handleMarkAllRead = useCallback(() => {
		if (visibleItems.length === 0) return
		const snapshot = visibleItems
		const snapshotKeys = new Set(snapshot.map(itemKey))
		settledRef.current = false
		setPendingKeys(snapshotKeys)

		const commit = () => {
			if (settledRef.current) return
			settledRef.current = true
			for (const item of snapshot) {
				const target = item.latest_event_id ?? 0
				if (target <= 0) continue
				markRead.mutate({
					entityType: item.entity_type,
					entityId: item.entity_id,
					lastEventId: target,
				})
			}
			setPendingKeys(new Set())
		}

		const restore = () => {
			if (settledRef.current) return
			settledRef.current = true
			setPendingKeys(new Set())
		}

		const count = snapshot.length
		toast(`Marked ${count} thread${count === 1 ? '' : 's'} as read`, {
			duration: UNDO_WINDOW_MS,
			action: { label: 'Undo', onClick: restore },
			onAutoClose: commit,
			onDismiss: commit,
		})
	}, [markRead, visibleItems])

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

	if (visibleItems.length === 0) {
		return (
			<div className="space-y-2">
				<EmptyState
					title="All caught up"
					description="New comments and replies on things you're subscribed to will appear here."
					className="py-8"
				/>
				<SparseComposer itemsCount={0} />
			</div>
		)
	}

	const onboardingItems = visibleItems.filter((item) => item.object?.type === 'onboarding_session')
	const regularItems = visibleItems.filter((item) => item.object?.type !== 'onboarding_session')
	const isSparse = visibleItems.length < 3

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-end">
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs min-h-[44px] sm:min-h-0"
					onClick={handleMarkAllRead}
					title="Mark all as read (Alt+U)"
				>
					Mark all as read ({visibleItems.length})
				</Button>
			</div>
			{onboardingItems.map((item) => (
				<OnboardingPromptCard
					key={`${item.entity_type}-${item.entity_id}`}
					workspaceId={workspaceId}
					item={item}
				/>
			))}
			{regularItems.map((item) => (
				<UnreadThreadCard
					key={`${item.entity_type}-${item.entity_id}`}
					workspaceId={workspaceId}
					item={item}
				/>
			))}
			{isSparse ? <SparseComposer itemsCount={visibleItems.length} /> : null}
		</div>
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
