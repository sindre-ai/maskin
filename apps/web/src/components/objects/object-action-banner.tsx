import { PulseCard } from '@/components/pulse/pulse-card'
import { useActors } from '@/hooks/use-actors'
import {
	useObjectNotifications,
	useRespondNotification,
	useUpdateNotification,
} from '@/hooks/use-notifications'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { resolveNavigationPath } from '@/lib/navigation'
import { useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { toast } from 'sonner'

interface ObjectActionBannerProps {
	objectId: string
	workspaceId: string
}

export function ObjectActionBanner({ objectId, workspaceId }: ObjectActionBannerProps) {
	const { data: notifications } = useObjectNotifications(workspaceId, objectId)
	const { data: actors } = useActors(workspaceId)
	const respond = useRespondNotification(workspaceId)
	const update = useUpdateNotification(workspaceId)
	const navigate = useNavigate()

	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) {
			map.set(actor.id, actor)
		}
		return map
	}, [actors])

	const handleAction = (
		notification: NotificationResponse,
		response: unknown,
		nav?: { to: string; id?: string },
	) => {
		respond.mutate(
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
		update.mutate(
			{ id, data: { status: 'dismissed' } },
			{
				onError: () => {
					toast.error('Failed to dismiss. Please try again.')
				},
			},
		)
	}

	if (!notifications?.length) return null

	return (
		<div className="space-y-3 mb-4 max-h-[50vh] overflow-y-auto">
			{notifications.map((notification) => (
				<PulseCard
					key={notification.id}
					notification={notification}
					actorsById={actorsById}
					onAction={handleAction}
					onDismiss={handleDismiss}
				/>
			))}
		</div>
	)
}
