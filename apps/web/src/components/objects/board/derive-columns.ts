import type { ActorListItem, ObjectResponse } from '@/lib/api'

export interface BoardColumn {
	id: string
	label: string
	value: string
	status?: string
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
	groupBy?: string,
	actors?: ActorListItem[],
): BoardColumn[] {
	const statuses = statusesByType[objectType] ?? []
	if (statuses.length === 0) return []

	if (groupBy && groupBy !== 'status') {
		const groups = new Map<string, { label: string; objects: ObjectResponse[] }>()
		for (const obj of objects) {
			if (obj.type !== objectType) continue
			const value = getGroupValue(obj, groupBy)
			const key = value || 'No value'
			const label = getGroupLabel(groupBy, key, actors)
			const existing = groups.get(key)
			groups.set(key, { label, objects: [...(existing?.objects ?? []), obj] })
		}

		return Array.from(groups.entries()).map(([value, group]) => ({
			id: `${groupBy}:${value}`,
			label: group.label,
			value,
			objects: getOrderedObjects(group.objects),
		}))
	}

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
		id: `status:${status}`,
		label: status,
		value: status,
		status,
		objects: getOrderedObjects(bucketByStatus.get(status) ?? []),
	}))
}

function getGroupLabel(groupBy: string, value: string, actors?: ActorListItem[]) {
	if ((groupBy === 'owner' || groupBy === 'createdBy') && value !== 'No value') {
		return actors?.find((actor) => actor.id === value)?.name ?? value
	}
	return value
}

function getGroupValue(object: ObjectResponse, groupBy: string): string {
	if (groupBy.startsWith('metadata.')) {
		const key = groupBy.slice('metadata.'.length)
		const metadata = object.metadata as Record<string, unknown> | null
		const value = metadata?.[key]
		return value == null || value === '' ? '' : String(value)
	}

	const value = object[groupBy as keyof ObjectResponse]
	return value == null || value === '' ? '' : String(value)
}
