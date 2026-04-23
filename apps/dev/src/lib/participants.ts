import type { Database } from '@maskin/db'
import { relationships } from '@maskin/db/schema'
import { PARTICIPANT_RELATIONSHIP_TYPES } from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'

// Mutable copy so Drizzle's `inArray` accepts it without the double-cast trick.
const PARTICIPANT_TYPE_LIST: string[] = [...PARTICIPANT_RELATIONSHIP_TYPES]

export type Participants = { assignees: string[]; watchers: string[] }

/**
 * Fetch assignees + watchers for a batch of objects in one query.
 * Returns a Map keyed by objectId. Objects with no edges get empty arrays.
 */
export async function fetchParticipants(
	db: Database,
	objectIds: string[],
): Promise<Map<string, Participants>> {
	const result = new Map<string, Participants>()
	for (const id of objectIds) result.set(id, { assignees: [], watchers: [] })

	if (objectIds.length === 0) return result

	const rows = await db
		.select({
			sourceId: relationships.sourceId,
			targetId: relationships.targetId,
			type: relationships.type,
		})
		.from(relationships)
		.where(
			and(
				eq(relationships.sourceType, 'object'),
				eq(relationships.targetType, 'actor'),
				inArray(relationships.sourceId, objectIds),
				inArray(relationships.type, PARTICIPANT_TYPE_LIST),
			),
		)

	for (const row of rows) {
		const bucket = result.get(row.sourceId)
		if (!bucket) continue
		if (row.type === 'assigned_to') bucket.assignees.push(row.targetId)
		else if (row.type === 'watches') bucket.watchers.push(row.targetId)
	}

	return result
}

/** Attach `assignees` and `watchers` arrays to each object row. */
export async function withParticipants<T extends { id: string } & Record<string, unknown>>(
	db: Database,
	rows: T[],
): Promise<(T & Participants)[]> {
	const participants = await fetchParticipants(
		db,
		rows.map((r) => r.id),
	)
	return rows.map((row) => {
		const p = participants.get(row.id) ?? { assignees: [], watchers: [] }
		return { ...row, assignees: p.assignees, watchers: p.watchers }
	})
}

/** Fetch participant actor IDs (assignees ∪ watchers) for one object. */
export async function fetchParticipantActors(
	db: Database,
	objectId: string,
): Promise<{ assignees: string[]; watchers: string[] }> {
	const map = await fetchParticipants(db, [objectId])
	return map.get(objectId) ?? { assignees: [], watchers: [] }
}
