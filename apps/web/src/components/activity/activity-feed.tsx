import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useEvents } from '@/hooks/use-events'
import type { EventResponse } from '@/lib/api'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef, useState } from 'react'
import { EmptyState } from '../shared/empty-state'
import { ListSkeleton } from '../shared/loading-skeleton'
import { ActivityItem } from './activity-item'

type ActivityFilter = 'all' | 'agent' | 'human' | 'object'

const FILTERS: { label: string; value: ActivityFilter }[] = [
	{ label: 'All', value: 'all' },
	{ label: 'Agents', value: 'agent' },
	{ label: 'Human', value: 'human' },
	{ label: 'Objects', value: 'object' },
]

interface ActivityFeedViewProps {
	events: EventResponse[]
	actorTypeById: Map<string, string>
	isLoading?: boolean
}

export function ActivityFeedView({
	events,
	actorTypeById,
	isLoading = false,
}: ActivityFeedViewProps) {
	const [activeFilter, setActiveFilter] = useState<ActivityFilter>('all')
	const parentRef = useRef<HTMLDivElement>(null)

	const filteredEvents = useMemo(() => {
		if (activeFilter === 'all') return events
		if (activeFilter === 'object') return events.filter((e) => e.entityType === 'object')
		const type = activeFilter // 'agent' | 'human'
		return events.filter((e) => actorTypeById.get(e.actorId) === type)
	}, [events, activeFilter, actorTypeById])

	const counts: Record<ActivityFilter, number> = useMemo(
		() => ({
			all: events.length,
			agent: events.filter((e) => actorTypeById.get(e.actorId) === 'agent').length,
			human: events.filter((e) => actorTypeById.get(e.actorId) === 'human').length,
			object: events.filter((e) => e.entityType === 'object').length,
		}),
		[events, actorTypeById],
	)

	const virtualizer = useVirtualizer({
		count: filteredEvents.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 52,
		overscan: 20,
	})

	if (isLoading) return <ListSkeleton rows={10} />

	return (
		<div>
			<div className="flex gap-2 mb-4">
				{FILTERS.map((f) => (
					<Button
						key={f.value}
						variant={activeFilter === f.value ? 'default' : 'outline'}
						size="sm"
						onClick={() => setActiveFilter(f.value)}
					>
						{f.label} {counts[f.value]}
					</Button>
				))}
			</div>

			{!filteredEvents.length ? (
				<EmptyState
					title="No activity yet"
					description="Events will appear here as actions occur"
				/>
			) : (
				<div ref={parentRef} className="h-[calc(100vh-13rem)] overflow-auto">
					<div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
						{virtualizer.getVirtualItems().map((virtualItem) => {
							const event = filteredEvents[virtualItem.index]
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
			)}
		</div>
	)
}

export function ActivityFeed({ workspaceId }: { workspaceId: string }) {
	const { data: events, isLoading } = useEvents(workspaceId)
	const { data: actors } = useActors(workspaceId)

	const actorTypeById = useMemo(() => {
		const map = new Map<string, string>()
		for (const actor of actors ?? []) {
			map.set(actor.id, actor.type)
		}
		return map
	}, [actors])

	return (
		<ActivityFeedView events={events ?? []} actorTypeById={actorTypeById} isLoading={isLoading} />
	)
}
