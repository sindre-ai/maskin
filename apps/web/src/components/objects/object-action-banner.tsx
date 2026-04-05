import { NotificationInput } from '@/components/notifications/notification-input'
import { useObjectNotifications, useRespondNotification } from '@/hooks/use-notifications'
import { AlertTriangle } from 'lucide-react'

interface ObjectActionBannerProps {
	objectId: string
	workspaceId: string
}

export function ObjectActionBanner({ objectId, workspaceId }: ObjectActionBannerProps) {
	const { data: notifications } = useObjectNotifications(workspaceId, objectId)
	const respond = useRespondNotification(workspaceId)

	if (!notifications?.length) return null

	return (
		<div className="space-y-3 mb-4">
			{notifications.map((notification) => {
				const metadata = notification.metadata ?? {}
				return (
					<div
						key={notification.id}
						className="border-l-4 border-amber-500 bg-amber-50 dark:bg-amber-950/30 rounded-r-md p-4"
					>
						<div className="flex items-start gap-2">
							<AlertTriangle
								size={16}
								className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0"
							/>
							<div className="flex-1 min-w-0">
								<p className="text-sm font-medium text-amber-900 dark:text-amber-200">
									{notification.title}
								</p>
								{notification.content && (
									<p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
										{notification.content}
									</p>
								)}
								{metadata.input_type && (
									<NotificationInput
										metadata={metadata}
										onSubmit={(response) => respond.mutate({ id: notification.id, response })}
									/>
								)}
							</div>
						</div>
					</div>
				)
			})}
		</div>
	)
}
