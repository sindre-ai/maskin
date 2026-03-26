import { useActors } from '@/hooks/use-actors'
import { useEvents } from '@/hooks/use-events'
import type { EventResponse } from '@/lib/api'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'
import { EmptyState } from '../shared/empty-state'
import { ListSkeleton } from '../shared/loading-skeleton'
import { type CategoryFilter, matchesFilter } from './activity-filters'
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

export function ActivityFeed({
	workspaceId,
	filter,
}: {
	workspaceId: string
	filter?: CategoryFilter
}) {
	const { data: events, isLoading } = useEvents(workspaceId)
	const { data: actors } = useActors(workspaceId)

	const actorTypeMap = useMemo(() => {
		const map = new Map<string, string>()
		for (const actor of actors ?? []) {
			map.set(actor.id, actor.type)
		}
		return map
	}, [actors])

	const filteredEvents = useMemo(() => {
		const all = events ?? []
		if (!filter) return all
		return all.filter((event) => matchesFilter(event, filter, actorTypeMap))
	}, [events, filter, actorTypeMap])

	return <ActivityFeedView events={filteredEvents} isLoading={isLoading} />
}
