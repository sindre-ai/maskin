import { useEvents } from '@/hooks/use-events'
import type { EventResponse } from '@/lib/api'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import { EmptyState } from '../shared/empty-state'
import { ListSkeleton } from '../shared/loading-skeleton'
import { ActivityItem } from './activity-item'

interface ActivityFeedViewProps {
	events: EventResponse[]
	isLoading?: boolean
}

export function ActivityFeedView({ events, isLoading = false }: ActivityFeedViewProps) {
	const parentRef = useRef<HTMLDivElement>(null)

	const virtualizer = useVirtualizer({
		count: events.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 52,
		overscan: 20,
	})

	if (isLoading) return <ListSkeleton rows={10} />
	if (!events.length)
		return (
			<EmptyState title="No activity yet" description="Events will appear here as actions occur" />
		)

	return (
		<div ref={parentRef} className="h-[calc(100vh-10rem)] overflow-auto">
			<div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
				{virtualizer.getVirtualItems().map((virtualItem) => {
					const event = events[virtualItem.index]
					return (
						<div
							key={virtualItem.key}
							style={{
								position: 'absolute',
								top: 0,
								left: 0,
								width: '100%',
								transform: `translateY(${virtualItem.start}px)`,
							}}
						>
							<ActivityItem event={event} />
						</div>
					)
				})}
			</div>
		</div>
	)
}

export function ActivityFeed({ workspaceId }: { workspaceId: string }) {
	const { data: events, isLoading } = useEvents(workspaceId)

	return <ActivityFeedView events={events ?? []} isLoading={isLoading} />
}
