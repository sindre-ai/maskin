import { ActivityFeed } from '@/components/activity/activity-feed'
import { type CategoryFilter, FILTER_TABS } from '@/components/activity/activity-filters'
import { PageHeader } from '@/components/layout/page-header'
import { RouteError } from '@/components/shared/route-error'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
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

	const navigateFilter = (value: CategoryFilter | undefined) =>
		navigate({
			to: '/$workspaceId/activity',
			params: { workspaceId },
			search: { filter: value },
		})

	const activeLabel = FILTER_TABS.find((t) => t.value === filter)?.label ?? 'All'

	return (
		<div className="flex flex-col h-full min-h-0">
			<PageHeader title="Activity" />

			{/* Mobile: dropdown */}
			<div className="md:hidden mb-4 shrink-0">
				<Select
					value={filter ?? '__all__'}
					onValueChange={(v) => navigateFilter(v === '__all__' ? undefined : (v as CategoryFilter))}
				>
					<SelectTrigger className="w-fit">
						<SelectValue>{activeLabel}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{FILTER_TABS.map((tab) => (
							<SelectItem key={tab.label} value={tab.value ?? '__all__'}>
								{tab.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Desktop: button row */}
			<div className="hidden md:flex gap-1 mb-4 shrink-0">
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
						onClick={() => navigateFilter(tab.value)}
					>
						{tab.label}
					</button>
				))}
			</div>

			<div className="flex-1 min-h-0">
				<ActivityFeed workspaceId={workspaceId} filter={filter} />
			</div>
		</div>
	)
}
