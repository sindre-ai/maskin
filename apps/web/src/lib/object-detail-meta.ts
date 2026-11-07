import type { ObjectResponse, RelationshipResponse } from '@/lib/api'

/** The flow an item belongs to: the source of its first `in_loop` edge. */
export function findFlowId(
	relationships: RelationshipResponse[] | undefined,
	objectId: string,
): string | undefined {
	return relationships?.find((rel) => rel.type === 'in_loop' && rel.targetId === objectId)?.sourceId
}

const DUE_KEYS = ['due', 'due_date', 'dueDate'] as const

/**
 * The due date, only when the item carries one in its custom fields. There is no
 * first-class due field, so a row that has nothing to say is not drawn.
 */
export function readDue(object: Pick<ObjectResponse, 'metadata'>): string | undefined {
	const metadata = object.metadata as Record<string, unknown> | null
	if (!metadata) return undefined
	for (const key of DUE_KEYS) {
		const value = metadata[key]
		if (typeof value !== 'string' || value.trim() === '') continue
		const parsed = Date.parse(value)
		if (!Number.isFinite(parsed)) return value.trim()
		return new Date(parsed).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
	}
	return undefined
}
