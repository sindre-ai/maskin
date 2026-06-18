import { OnboardingPromptCard } from '@/components/foryou/onboarding-prompt-card'
import { UnreadThreadCard } from '@/components/foryou/unread-thread-card'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useMarkRead, useUnread } from '@/hooks/use-subscriptions'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { CheckCheck } from 'lucide-react'
import { useCallback } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
			{children}
		</h2>
	)
}

function ForYouDashboard() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useUnread(workspaceId)
	const markRead = useMarkRead(workspaceId)
	const items = data?.items ?? []

	const onboardingItems = items.filter((item) => item.object?.type === 'onboarding_session')
	const regularItems = items.filter((item) => item.object?.type !== 'onboarding_session')

	// Mark every unread thread read up to its latest event in one pass, so the
	// inbox can be cleared without opening each card. Onboarding prompts are
	// left alone — they're guided actions, not unread activity.
	const handleMarkAllRead = useCallback(() => {
		for (const item of regularItems) {
			const target = item.latest_event_id ?? 0
			if (target <= 0) continue
			markRead.mutate({
				entityType: item.entity_type,
				entityId: item.entity_id,
				lastEventId: target,
			})
		}
	}, [regularItems, markRead])

	if (isLoading) {
		return (
			<div className="space-y-4">
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</div>
		)
	}

	if (items.length === 0) {
		return (
			<EmptyState
				title="You're all caught up"
				description="New comments and replies on things you're subscribed to will show up here. Until then, there's nothing that needs your attention."
				action={
					<Button asChild variant="outline" size="sm">
						<Link
							to="/$workspaceId/objects"
							params={{ workspaceId }}
							search={{
								type: undefined,
								status: undefined,
								driver: undefined,
								sort: 'createdAt',
								order: 'desc',
								q: undefined,
								groupBy: undefined,
								ids: undefined,
							}}
						>
							Browse objects
						</Link>
					</Button>
				}
			/>
		)
	}

	return (
		<div className="space-y-6">
			{onboardingItems.length > 0 && (
				<section className="space-y-3">
					<SectionLabel>Getting started</SectionLabel>
					<div className="space-y-4">
						{onboardingItems.map((item) => (
							<OnboardingPromptCard
								key={`${item.entity_type}-${item.entity_id}`}
								workspaceId={workspaceId}
								item={item}
							/>
						))}
					</div>
				</section>
			)}

			{regularItems.length > 0 && (
				<section className="space-y-3">
					<div className="flex items-center justify-between gap-2">
						<SectionLabel>
							Unread
							<span className="ml-1.5 font-normal normal-case tracking-normal">
								{regularItems.length}
							</span>
						</SectionLabel>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 gap-1.5 px-2 text-xs"
							onClick={handleMarkAllRead}
							disabled={markRead.isPending}
						>
							<CheckCheck size={14} />
							Mark all as read
						</Button>
					</div>
					<div className="space-y-4">
						{regularItems.map((item) => (
							<UnreadThreadCard
								key={`${item.entity_type}-${item.entity_id}`}
								workspaceId={workspaceId}
								item={item}
							/>
						))}
					</div>
				</section>
			)}
		</div>
	)
}
