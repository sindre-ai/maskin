import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import type { ResolvedRelationship } from './related-objects-table'

interface RelatedGraphSlice {
	relationships?: RelationshipResponse[] | null
	connected_objects?: ObjectResponse[] | null
}

// Resolve every unique edge on `ownerId` against the objects the graph returns,
// falling back to the workspace listing for endpoints the graph call didn't
// hydrate. Shared so the Related tab body and the tab-trigger count stay in
// lockstep off the same shape.
export function resolveRelatedRows(
	graph: RelatedGraphSlice | null | undefined,
	allObjects: ObjectResponse[] | null | undefined,
	ownerId: string,
): ResolvedRelationship[] {
	const rels = graph?.relationships ?? []
	const objMap = new Map<string, ObjectResponse>()
	for (const o of graph?.connected_objects ?? []) objMap.set(o.id, o)
	if (allObjects) for (const o of allObjects) objMap.set(o.id, o)

	const seen = new Set<string>()
	const out: ResolvedRelationship[] = []
	for (const rel of rels) {
		if (seen.has(rel.id)) continue
		seen.add(rel.id)
		const otherId = rel.sourceId === ownerId ? rel.targetId : rel.sourceId
		const obj = objMap.get(otherId)
		if (obj) out.push({ rel, object: obj })
	}
	return out
}
