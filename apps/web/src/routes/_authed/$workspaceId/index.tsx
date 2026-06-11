import { OnboardingPromptCard } from '@/components/foryou/onboarding-prompt-card'
import { UnreadThreadCard } from '@/components/foryou/unread-thread-card'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useUnread } from '@/hooks/use-subscriptions'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ForYouDashboard() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useUnread(workspaceId)
	const items = data?.items ?? []

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
				title="All caught up"
				description="New comments and replies on things you're subscribed to will appear here."
			/>
		)
	}

	const onboardingItems = items.filter((item) => item.object?.type === 'onboarding_session')
	const regularItems = items.filter((item) => item.object?.type !== 'onboarding_session')

	return (
		<div className="space-y-4">
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
		</div>
	)
}
