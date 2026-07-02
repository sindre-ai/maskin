import { ActivityFeed } from '@/components/activity/activity-feed'
import { type CategoryFilter, FILTER_TABS } from '@/components/activity/activity-filters'
import { PageHeader } from '@/components/layout/page-header'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { RouteError } from '@/components/shared/route-error'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

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
	const [createPickerOpen, setCreatePickerOpen] = useState(false)

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

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
			<FilterTabs
				tabs={FILTER_TABS}
				value={filter}
				onChange={navigateFilter}
				aria-label="Activity filter"
				className="hidden md:flex mb-4 shrink-0"
			/>

			<div className="flex-1 min-h-0">
				<ActivityFeed workspaceId={workspaceId} filter={filter} />
			</div>
			<CreatePicker open={createPickerOpen} onOpenChange={setCreatePickerOpen} />
		</div>
	)
}
