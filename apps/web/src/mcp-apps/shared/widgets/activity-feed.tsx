import { ActivityFeedView } from '@/components/activity/activity-feed'
import { cn } from '@/lib/cn'
import { WebAppLink } from '../web-app-link'
import type { ActivityFeedProps } from './types'

/**
 * Thin wrapper around the web app's `ActivityFeedView`. Keeps the catalog
 * surface complete (so MCP cards never need to reach across into
 * `@/components/activity` directly) and adds the deep-link affordance the
 * chat surface wants.
 */
export function ActivityFeed({ events, className }: ActivityFeedProps) {
	return (
		<div className={cn('flex flex-col h-full', className)}>
			<div className="flex justify-end p-3 pb-0">
				<WebAppLink target={{ kind: 'activity' }} label="View activity in Maskin" />
			</div>
			<ActivityFeedView events={events} />
		</div>
	)
}
