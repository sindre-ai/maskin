import { PulseCard } from '@/components/pulse/pulse-card'
import { PulseFilters } from '@/components/pulse/pulse-filters'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { useActors } from '@/hooks/use-actors'
import {
	useNotifications,
	useRespondNotification,
	useUpdateNotification,
} from '@/hooks/use-notifications'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, CheckCircle, Lightbulb, MessageSquare, TrendingUp } from 'lucide-react'
import { useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: PulseDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const PULSE_SECTIONS = [
	{
		type: 'needs_input',
		label: 'Needs your input',
		Icon: MessageSquare,
	},
	{
		type: 'alert',
		label: 'Alerts',
		Icon: AlertTriangle,
	},
	{
		type: 'recommendation',
		label: 'Recommendations',
		Icon: TrendingUp,
	},
	{
		type: 'good_news',
		label: 'Good news',
		Icon: Lightbulb,
	},
] as const

function PulseDashboard() {
	const { workspaceId } = useWorkspace()
	const { data: notifications, isLoading } = useNotifications(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const updateNotification = useUpdateNotification(workspaceId)
	const respondNotification = useRespondNotification(workspaceId)
	const [activeFilter, setActiveFilter] = useState('all')

	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) {
			map.set(actor.id, actor)
		}
		return map
	}, [actors])

	// Only show pending/seen notifications (not resolved/dismissed)
	const activeNotifications = useMemo(
		() => (notifications ?? []).filter((n) => n.status === 'pending' || n.status === 'seen'),
		[notifications],
	)

	const filtered = useMemo(() => {
		if (activeFilter === 'all') return activeNotifications
		return activeNotifications.filter((n) => n.type === activeFilter)
	}, [activeNotifications, activeFilter])

	const counts = useMemo(() => {
		const c: Record<string, number> = { all: activeNotifications.length }
		for (const n of activeNotifications) {
			c[n.type] = (c[n.type] ?? 0) + 1
		}
		return c
	}, [activeNotifications])

	const groupedByType = useMemo(() => {
		const map = new Map<string, NotificationResponse[]>()
		for (const n of filtered) {
			const arr = map.get(n.type) ?? []
			arr.push(n)
			map.set(n.type, arr)
		}
		return map
	}, [filtered])

	const handleRespond = (id: string, response: unknown) => {
		respondNotification.mutate({ id, response })
	}

	const handleDismiss = (id: string) => {
		updateNotification.mutate({ id, data: { status: 'dismissed' } })
	}

	const pendingCount = activeNotifications.filter((n) => n.status === 'pending').length

	const renderCards = (items: NotificationResponse[]) =>
		items.map((notification) => (
			<PulseCard
				key={notification.id}
				notification={notification}
				actorsById={actorsById}
				onRespond={handleRespond}
				onDismiss={handleDismiss}
			/>
		))

	return (
		<div>
			<p className="text-sm text-muted-foreground pb-6">
				{pendingCount > 0
					? `${pendingCount} ${pendingCount === 1 ? 'thing needs' : 'things need'} your attention. The rest is handled.`
					: ''}
			</p>

			{isLoading ? (
				<div className="space-y-4">
					<CardSkeleton />
					<CardSkeleton />
					<CardSkeleton />
				</div>
			) : activeNotifications.length === 0 ? (
				<div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
					<CheckCircle className="h-8 w-8 text-success" />
					<p className="text-sm font-medium">All clear.</p>
					<p className="text-xs">Agents will notify you when they need your input.</p>
				</div>
			) : (
				<>
					<PulseFilters active={activeFilter} onChange={setActiveFilter} counts={counts} />

					{activeFilter === 'all' ? (
						// Grouped by section
						<div className="space-y-8">
							{PULSE_SECTIONS.map(({ type, label, Icon }) => {
								const items = groupedByType.get(type)
								if (!items?.length) return null
								return (
									<div key={type}>
										<div className="flex items-center gap-2 mb-3">
											<Icon className="h-3.5 w-3.5 text-muted-foreground" />
											<span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												{label}
											</span>
											<Badge variant="outline" className="text-xs h-4 px-1.5">
												{items.length}
											</Badge>
										</div>
										<div className="space-y-3">{renderCards(items)}</div>
									</div>
								)
							})}
						</div>
					) : (
						// Flat filtered list
						<div className="space-y-4">
							{filtered.map((notification) => (
								<PulseCard
									key={notification.id}
									notification={notification}
									actorsById={actorsById}
									onRespond={handleRespond}
									onDismiss={handleDismiss}
								/>
							))}
							{filtered.length === 0 && (
								<p className="text-sm text-muted-foreground text-center py-8">
									No {activeFilter.replace(/_/g, ' ')} notifications
								</p>
							)}
						</div>
					)}
				</>
			)}
		</div>
	)
}
