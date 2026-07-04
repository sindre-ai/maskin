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
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ForYouDashboard() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useUnread(workspaceId)
	const items = data?.items ?? []
	const [activeId, setActiveId] = useState<string | null>(null)
	const [activeReplyTarget, setActiveReplyTarget] = useState<number | null>(null)
	const { open: composerOpen, setOpen: setComposerOpen } = useNewConversationComposer()
	const markRead = useMarkRead(workspaceId)

	// Onboarding sessions render as their own prompt card above the thread stream.
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

	// Fires one mutation per thread — non-batched by design; typical inboxes are small
	// and a batch endpoint doesn't exist yet. Onboarding prompts render as their own
	// card and aren't part of the unread thread stream, so they're excluded here.
	function handleMarkAllRead() {
		for (const item of sortedRegular) {
			markItemRead(item)
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

	const isSparse = items.length < 3

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
						className="py-4 md:py-8"
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
					{onboardingItems.map((item) => (
						<OnboardingPromptCard
							key={`${item.entity_type}-${item.entity_id}`}
							workspaceId={workspaceId}
							item={item}
						/>
					))}
					{sortedRegular.map((item) => (
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
					{isSparse ? <SparseComposer itemsCount={items.length} /> : null}
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
