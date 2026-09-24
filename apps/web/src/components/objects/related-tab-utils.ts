import type { GraphFileSummary, ObjectResponse, RelationshipResponse } from '@/lib/api'
import type { ResolvedRelationship, ResolvedRow } from './related-objects-table'

interface RelatedGraphSlice {
	relationships?: RelationshipResponse[] | null
	connected_objects?: ObjectResponse[] | null
	files?: GraphFileSummary[] | null
}

// Resolve every unique edge on `ownerId` against the endpoints the graph
// returns, falling back to the workspace listing for objects the graph call
// didn't hydrate. Files hydrate off the graph payload's `files[]` array.
// Shared so the Related tab body and the tab-trigger count stay in lockstep
// off the same shape.
export function resolveRelatedRows(
	graph: RelatedGraphSlice | null | undefined,
	allObjects: ObjectResponse[] | null | undefined,
	ownerId: string,
): ResolvedRow[] {
	const rels = graph?.relationships ?? []
	const objMap = new Map<string, ObjectResponse>()
	for (const o of graph?.connected_objects ?? []) objMap.set(o.id, o)
	if (allObjects) for (const o of allObjects) objMap.set(o.id, o)
	const fileMap = new Map<string, GraphFileSummary>()
	for (const f of graph?.files ?? []) fileMap.set(f.id, f)

	const seen = new Set<string>()
	const out: ResolvedRow[] = []
	for (const rel of rels) {
		if (seen.has(rel.id)) continue
		seen.add(rel.id)
		const otherId = rel.sourceId === ownerId ? rel.targetId : rel.sourceId
		const obj = objMap.get(otherId)
		if (obj) {
			out.push({ kind: 'object', rel, object: obj })
			continue
		}
		const file = fileMap.get(otherId)
		if (file) out.push({ kind: 'file', rel, file })
	}
	return out
}

// Back-compat helper for call sites that only want object rows — same
// signature the old `resolveRelatedRows` had (object-only). Filter down
// after resolve so we only expose one resolver at the module boundary.
export function resolveRelatedObjectRows(
	graph: RelatedGraphSlice | null | undefined,
	allObjects: ObjectResponse[] | null | undefined,
	ownerId: string,
): ResolvedRelationship[] {
	return resolveRelatedRows(graph, allObjects, ownerId).filter(
		(r): r is ResolvedRelationship => r.kind === 'object',
	)
}
