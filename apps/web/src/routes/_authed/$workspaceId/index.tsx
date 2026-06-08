import { NorthStarPromptCard } from '@/components/foryou/north-star-prompt-card'
import { UnreadThreadCard } from '@/components/foryou/unread-thread-card'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useBets } from '@/hooks/use-bets'
import { useUnread } from '@/hooks/use-subscriptions'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: ForYouDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ForYouDashboard() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useUnread(workspaceId)
	const { data: bets, isLoading: betsLoading } = useBets(workspaceId)
	const items = data?.items ?? []

	const [northStarDismissed, setNorthStarDismissed] = useState(() =>
		Boolean(localStorage.getItem(`north_star_answered_${workspaceId}`)),
	)

	if (isLoading || betsLoading) {
		return (
			<div className="space-y-4">
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</div>
		)
	}

	const showNorthStarPrompt = (bets?.length ?? 0) === 0 && !northStarDismissed

	if (!showNorthStarPrompt && items.length === 0) {
		return (
			<EmptyState
				title="All caught up"
				description="New comments and replies on things you're subscribed to will appear here."
			/>
		)
	}

	return (
		<div className="space-y-4">
			{showNorthStarPrompt && (
				<NorthStarPromptCard
					workspaceId={workspaceId}
					onDismiss={() => setNorthStarDismissed(true)}
				/>
			)}
			{items.map((item) => (
				<UnreadThreadCard
					key={`${item.entity_type}-${item.entity_id}`}
					workspaceId={workspaceId}
					item={item}
				/>
			))}
		</div>
	)
}
