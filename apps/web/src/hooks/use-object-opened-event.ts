import { trackFirstResultOpened, trackLoopResultOpened, trackObjectOpened } from '@/lib/analytics'
import type { ActorResponse, ObjectResponse, RelationshipResponse } from '@/lib/api'
import { findFlowId } from '@/lib/object-detail-meta'
import { useEffect, useRef } from 'react'

/**
 * The run that made an item: the oldest session with a produced_by edge to it, the same pick
 * the Origin block makes. Null when no run did.
 */
export function findSourceSessionId(
	relationships: RelationshipResponse[],
	objectId: string,
): string | null {
	const edge = relationships
		.filter(
			(r) => r.type === 'produced_by' && r.sourceType === 'session' && r.targetId === objectId,
		)
		.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))[0]
	return edge?.sourceId ?? null
}

/**
 * One `object_opened` per visit to an item page, plus `loop_result_opened` when a run of a flow
 * made it. Waits for the graph and the actor list, since the source run and the maker's actor
 * type live there. Keyed on the id so refetches, tab changes and StrictMode's double effect do
 * not repeat it; opening another item, or the same one again after leaving, fires again.
 */
export function useObjectOpenedEvent(
	object: Pick<ObjectResponse, 'id' | 'type' | 'createdBy'>,
	relationships: RelationshipResponse[] | undefined,
	actors: Pick<ActorResponse, 'id' | 'type'>[] | undefined,
): void {
	const firedForRef = useRef<string | null>(null)
	const { id, type, createdBy } = object
	useEffect(() => {
		if (!relationships || !actors || firedForRef.current === id) return
		firedForRef.current = id
		const sourceSessionId = findSourceSessionId(relationships, id)
		const createdByActorType = actors.find((a) => a.id === createdBy)?.type ?? 'unknown'
		trackObjectOpened({
			entity_id: id,
			object_subtype: type,
			source_session_id: sourceSessionId,
			created_by_actor_type: createdByActorType,
		})
		if (sourceSessionId && createdByActorType === 'agent') trackFirstResultOpened()
		const loopId = findFlowId(relationships, id)
		if (loopId && (sourceSessionId || createdByActorType !== 'human')) {
			trackLoopResultOpened({
				entity_id: id,
				loop_id: loopId,
				object_subtype: type,
				source_session_id: sourceSessionId,
				created_by_actor_type: createdByActorType,
			})
		}
	}, [id, type, createdBy, relationships, actors])
}
