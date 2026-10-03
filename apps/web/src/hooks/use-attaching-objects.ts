import { useQuery } from '@tanstack/react-query'
import type { ActorListItem, ObjectResponse, RelationshipResponse } from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'
import type { AttachingObject, DriverType, ObjectType } from '../lib/viewer-provenance'

// The six-variant provenance UI (see `resolveProvenance` in
// `viewer-provenance.ts`) needs richer fields than the raw `RelationshipResponse`
// carries — the source object's title/type/driver, the driver actor's type
// (human vs agent), and the attacher's display name. This hook batches the
// three lookups in parallel and hands the panel a ready-to-render list.
//
// The archived / target-archived flags come from cross-referencing the object
// status returned by GET /objects. In this workspace an object's `status`
// carries the value `archived` when the row is soft-deleted, and the relation
// row survives it — so a source object whose status is `archived` fires the
// `orphaned` (mid-review) or `archived` (from the start) branch depending on
// whether the edge already existed. We treat any archived-parent case as
// `targetArchived: true` because the relationships endpoint doesn't tell us
// when the archival happened relative to the edge — the `archived` bucket in
// `resolveProvenance` is left empty by design; the strip's label is derived
// from the same source object title either way.
export function useAttachingObjects(workspaceId: string, fileId: string | null) {
	return useQuery({
		queryKey: queryKeys.attachingObjects.byFile(workspaceId, fileId ?? ''),
		queryFn: async (): Promise<AttachingObject[]> => {
			if (!fileId) return []

			const edges = await api.relationships.list(workspaceId, {
				target_id: fileId,
				type: 'attached',
			})
			if (edges.length === 0) return []

			const sourceIds = Array.from(new Set(edges.map((e) => e.sourceId)))
			const creatorIds = Array.from(new Set(edges.map((e) => e.createdBy)))

			const [objectsResult, actorsResult] = await Promise.all([
				fetchObjectsById(sourceIds),
				fetchActors(workspaceId),
			])
			const objectById = new Map(objectsResult.map((o) => [o.id, o]))
			const actorById = new Map(actorsResult.map((a) => [a.id, a]))

			const rows: AttachingObject[] = []
			for (const edge of edges) {
				const obj = objectById.get(edge.sourceId)
				const creator = actorById.get(edge.createdBy)
				const driverActor = obj?.driver ? actorById.get(obj.driver) : null

				const type = normalizeObjectType(obj?.type ?? edge.sourceType)
				const isArchived = obj?.status === 'archived'

				rows.push({
					id: edge.sourceId,
					title: obj?.title ?? edge.sourceTitle ?? '(untitled)',
					type,
					driverId: obj?.driver ?? null,
					driverType: normalizeDriverType(driverActor?.type),
					attacherName: creator?.name ?? '(unknown)',
					attachedAt: edge.createdAt ?? new Date(0).toISOString(),
					// The relationships endpoint doesn't carry a "was archived after
					// this edge landed" flag today. We fold both cases into
					// `targetArchived` when the parent is currently archived — the
					// panel treats them identically (Send disabled + muted label).
					// If the parent later exposes a `deleted_at > edge.created_at`
					// flag we can split back into `archived` vs `orphaned`.
					targetArchived: isArchived,
					archived: false,
				})
			}
			return rows
		},
		enabled: !!workspaceId && !!fileId,
	})
}

async function fetchObjectsById(ids: string[]): Promise<ObjectResponse[]> {
	if (ids.length === 0) return []
	// GET /objects/:id is per-id; N objects → N requests, but N is bounded by
	// the number of attaching objects on a single file (typically 1, rarely 2,
	// almost never > 3 in the wild). If future usage pushes into the many
	// range, swap to a batch endpoint — this hook returns AttachingObject[]
	// so the call sites are insulated.
	return Promise.all(ids.map((id) => api.objects.get(id)))
}

async function fetchActors(workspaceId: string): Promise<ActorListItem[]> {
	return api.actors.list(workspaceId)
}

const OBJECT_TYPES: ObjectType[] = ['bet', 'task', 'insight', 'meeting', 'file', 'loop', 'session']

function normalizeObjectType(type: string): ObjectType {
	return (OBJECT_TYPES as string[]).includes(type) ? (type as ObjectType) : 'insight'
}

function normalizeDriverType(type: string | undefined): DriverType | null {
	if (type === 'human' || type === 'agent') return type
	return null
}

// Convenience selector: given a list of edges + hydrated data, resolve the
// provenance for the panel. Kept out of the hook so component tests can call
// `resolveProvenance` directly against a hand-built AttachingObject[] fixture
// without spinning up a QueryClient.
export function toAttachingObjects(
	edges: RelationshipResponse[],
	objectsById: Map<string, ObjectResponse>,
	actorsById: Map<string, { name: string; type: string }>,
): AttachingObject[] {
	return edges.map((edge) => {
		const obj = objectsById.get(edge.sourceId)
		const creator = actorsById.get(edge.createdBy)
		const driverActor = obj?.driver ? actorsById.get(obj.driver) : null
		return {
			id: edge.sourceId,
			title: obj?.title ?? edge.sourceTitle ?? '(untitled)',
			type: normalizeObjectType(obj?.type ?? edge.sourceType),
			driverId: obj?.driver ?? null,
			driverType: normalizeDriverType(driverActor?.type),
			attacherName: creator?.name ?? '(unknown)',
			attachedAt: edge.createdAt ?? new Date(0).toISOString(),
			targetArchived: obj?.status === 'archived',
			archived: false,
		}
	})
}
