import { NewConversationComposer } from '@/components/foryou/new-conversation-composer'
import { PersistentReplyBar } from '@/components/foryou/persistent-reply-bar'
import { UnreadThreadCard } from '@/components/foryou/unread-thread-card'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useMarkRead, useUnread } from '@/hooks/use-subscriptions'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ForYouDashboard() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useUnread(workspaceId)
	const items = data?.items ?? []
	const [activeId, setActiveId] = useState<string | null>(null)
	const [composerOpen, setComposerOpen] = useState(false)
	const markRead = useMarkRead(workspaceId)

	// mentions_you items ("Needs your input") sort before FYI items; stable within each tier
	const sorted = useMemo(
		() =>
			[...items].sort((a, b) => {
				if (a.mentions_you && !b.mentions_you) return -1
				if (!a.mentions_you && b.mentions_you) return 1
				return 0
			}),
		[items],
	)

	const activeItem = useMemo(
		() => (activeId ? items.find((item) => item.entity_id === activeId) : null),
		[activeId, items],
	)

	const totalUnread = items.reduce((sum, item) => sum + (item.unread_count ?? 0), 0)

	// ⌘N / Ctrl+N opens the composer. Prevent the default browser "new window" so
	// the shortcut stays scoped to this page.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			const mod = e.metaKey || e.ctrlKey
			if (!mod || e.key.toLowerCase() !== 'n' || e.shiftKey || e.altKey) return
			const target = e.target as HTMLElement | null
			const tag = target?.tagName?.toLowerCase()
			if (target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select') {
				return
			}
			e.preventDefault()
			setComposerOpen(true)
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [])

	// Fires one mutation per item — non-batched by design; typical inboxes are small and
	// a batch endpoint doesn't exist yet.
	function handleMarkAllRead() {
		for (const item of items) {
			const eventId = item.latest_event_id ?? 0
			if (eventId > 0) {
				markRead.mutate({
					entityType: item.entity_type,
					entityId: item.entity_id,
					lastEventId: eventId,
				})
			}
		}
	}

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

	if (items.length === 0) {
		return (
			<>
				<div className="flex flex-col gap-4">
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
					/>
				</div>
				{composer}
			</>
		)
	}

	return (
		<>
			<div className="flex flex-col gap-4 pb-28">
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
							className="h-7 px-2 text-xs"
							onClick={handleMarkAllRead}
							disabled={markRead.isPending || totalUnread === 0}
						>
							Mark all read
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
					{sorted.map((item) => (
						<UnreadThreadCard
							key={`${item.entity_type}-${item.entity_id}`}
							workspaceId={workspaceId}
							item={item}
							isActive={activeId === item.entity_id}
							onActivate={() => setActiveId(item.entity_id)}
						/>
					))}
				</div>
			</div>
			<PersistentReplyBar
				workspaceId={workspaceId}
				activeId={activeId}
				activeTitle={activeItem?.object?.title ?? null}
				onClear={() => setActiveId(null)}
			/>
			{composer}
		</>
	)
}
