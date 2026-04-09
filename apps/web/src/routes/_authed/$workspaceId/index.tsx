import { PulseCard } from '@/components/pulse/pulse-card'
import { PulseFilters } from '@/components/pulse/pulse-filters'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import {
	useNotifications,
	useRespondNotification,
	useUpdateNotification,
} from '@/hooks/use-notifications'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { resolveNavigationPath } from '@/lib/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: PulseDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function PulseDashboard() {
	const { workspaceId } = useWorkspace()
	const { data: notifications, isLoading } = useNotifications(workspaceId, {
		status: 'pending,seen',
	})
	const { data: actors } = useActors(workspaceId)
	const updateNotification = useUpdateNotification(workspaceId)
	const respondNotification = useRespondNotification(workspaceId)
	const navigate = useNavigate()
	const [activeFilter, setActiveFilter] = useState('all')

	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) {
			map.set(actor.id, actor)
		}
		return map
	}, [actors])

	const activeNotifications = notifications ?? []

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

	const handleAction = (
		notification: NotificationResponse,
		response: unknown,
		nav?: { to: string; id?: string },
	) => {
		respondNotification.mutate(
			{ id: notification.id, response },
			{
				onSuccess: () => {
					if (nav) {
						const path = resolveNavigationPath(workspaceId, nav, notification)
						if (path) navigate({ to: path })
						else toast.warning('Could not navigate to the requested page.')
					}
				},
				onError: () => {
					toast.error('Failed to respond. Please try again.')
				},
			},
		)
	}

	const handleDismiss = (id: string) => {
		updateNotification.mutate(
			{ id, data: { status: 'dismissed' } },
			{
				onError: () => {
					toast.error('Failed to dismiss. Please try again.')
				},
			},
		)
	}

	const pendingCount = activeNotifications.filter((n) => n.status === 'pending').length

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
				<EmptyState
					title="No notifications yet"
					description="Agents will notify you here when they need your input or have recommendations."
				/>
			) : (
				<>
					<PulseFilters active={activeFilter} onChange={setActiveFilter} counts={counts} />
					<div className="space-y-4">
						{filtered.map((notification) => (
							<PulseCard
								key={notification.id}
								notification={notification}
								actorsById={actorsById}
								onAction={handleAction}
								onDismiss={handleDismiss}
							/>
						))}
					</div>
					{filtered.length === 0 && (
						<p className="text-sm text-muted-foreground text-center py-8">
							No {activeFilter.replace('_', ' ')} notifications
						</p>
					)}
				</>
			)}
		</div>
	)
}
