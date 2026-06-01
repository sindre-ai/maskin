import type { ObjectResponse } from '@/lib/api'

export interface BoardColumn {
	status: string
	objects: ObjectResponse[]
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
		objects: bucketByStatus.get(status) ?? [],
	}))
}
