import { ActivityFeed } from '@/components/activity/activity-feed'
import { type CategoryFilter, FILTER_TABS } from '@/components/activity/activity-filters'
import { PageHeader } from '@/components/layout/page-header'
import { RouteError } from '@/components/shared/route-error'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/activity')({
	component: ActivityPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		filter: (typeof search.filter === 'string' ? search.filter : undefined) as
			| CategoryFilter
			| undefined,
	}),
})

function ActivityPage() {
	const { workspaceId } = useWorkspace()
	const { filter } = useSearch({ from: '/_authed/$workspaceId/activity' })
	const navigate = useNavigate()

	return (
		<div>
			<PageHeader title="Activity" />
			<div className="flex gap-1 mb-4">
				{FILTER_TABS.map((tab) => (
					<button
						key={tab.label}
						type="button"
						className={cn(
							'rounded px-3 py-1 text-sm',
							filter === tab.value
								? 'bg-muted text-foreground font-medium'
								: 'text-muted-foreground hover:text-foreground',
						)}
						onClick={() =>
							navigate({
								to: '/$workspaceId/activity',
								params: { workspaceId },
								search: { filter: tab.value },
							})
						}
					>
						{tab.label}
					</button>
				))}
			</div>
			<ActivityFeed workspaceId={workspaceId} filter={filter} />
		</div>
	)
}
