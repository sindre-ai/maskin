import { useActors } from '@/hooks/use-actors'
import { useEvents } from '@/hooks/use-events'
import type { ActorListItem } from '@/lib/api'
import { useMemo } from 'react'
import { ActivityFeedView } from './activity-feed-view'
import { type CategoryFilter, matchesFilter } from './activity-filters'

export { ActivityFeedView } from './activity-feed-view'

export function ActivityFeed({
	workspaceId,
	filter,
}: {
	workspaceId: string
	filter?: CategoryFilter
}) {
	const { data: events, isLoading } = useEvents(workspaceId)
	const { data: actors } = useActors(workspaceId)

	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	const filteredEvents = useMemo(() => {
		const all = events ?? []
		if (!filter) return all
		return all.filter((event) => matchesFilter(event, filter, actorsById))
	}, [events, filter, actorsById])

	return <ActivityFeedView events={filteredEvents} isLoading={isLoading} actorsById={actorsById} />
}
