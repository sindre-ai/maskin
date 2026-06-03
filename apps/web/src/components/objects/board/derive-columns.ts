import type { ObjectResponse } from '@/lib/api'

export interface BoardColumn {
	status: string
	objects: ObjectResponse[]
}

function getBoardOrder(object: ObjectResponse): number {
	const meta = object.metadata && typeof object.metadata === 'object' ? object.metadata : null
	const raw = meta ? (meta as Record<string, unknown>).board_order : null
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY
}

function compareDefaultCardOrder(a: ObjectResponse, b: ObjectResponse) {
	return (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
}

function getOrderedObjects(objects: ObjectResponse[]) {
	const fallbackIndexById = new Map<string, number>()
	for (const [index, object] of objects.slice().sort(compareDefaultCardOrder).entries()) {
		fallbackIndexById.set(object.id, index)
	}

	return objects.slice().sort((a, b) => {
		const aOrder = getBoardOrder(a)
		const bOrder = getBoardOrder(b)
		const aEffectiveOrder = Number.isFinite(aOrder) ? aOrder : (fallbackIndexById.get(a.id) ?? 0)
		const bEffectiveOrder = Number.isFinite(bOrder) ? bOrder : (fallbackIndexById.get(b.id) ?? 0)
		const orderDiff = aEffectiveOrder - bEffectiveOrder
		if (orderDiff !== 0) return orderDiff
		return compareDefaultCardOrder(a, b)
	})
}

/**
 * Derive board columns for a given object type from the workspace's configured
 * statuses. Returns one column per configured status in the order it appears in
 * settings. Objects with a status not in the configured list are dropped — the
 * page-level toolbar already constrains the visible status set, and Task 4 will
 * handle the wiring decision.
 */
export function deriveColumns(
	objectType: string,
	statusesByType: Record<string, string[] | undefined>,
	objects: ObjectResponse[],
): BoardColumn[] {
	const statuses = statusesByType[objectType] ?? []
	if (statuses.length === 0) return []

	const bucketByStatus = new Map<string, ObjectResponse[]>()
	for (const status of statuses) {
		bucketByStatus.set(status, [])
	}
	for (const obj of objects) {
		if (obj.type !== objectType) continue
		const bucket = bucketByStatus.get(obj.status)
		if (bucket) bucket.push(obj)
	}

	return statuses.map((status) => ({
		status,
		objects: getOrderedObjects(bucketByStatus.get(status) ?? []),
	}))
}
