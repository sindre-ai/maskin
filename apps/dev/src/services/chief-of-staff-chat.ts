import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, asc, eq } from 'drizzle-orm'

const CHIEF_OF_STAFF_NAME = 'Chief of Staff'

export async function findChiefOfStaffId(
	db: Database,
	workspaceId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, CHIEF_OF_STAFF_NAME),
				eq(actors.type, 'agent'),
			),
		)
		.limit(1)
	return row?.actorId ?? null
}

/**
 * The person an autonomous session's question is for: whoever started it when
 * that is a human, otherwise the workspace's longest-standing owner. A
 * trigger-driven run has no human of its own to point at.
 */
export async function resolveAskTargetHuman(
	db: Database,
	workspaceId: string,
	createdBy: string,
): Promise<string | null> {
	const [creator] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, createdBy))
		.limit(1)
	if (creator?.type === 'human') return createdBy

	const [owner] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.role, 'owner'),
				eq(actors.type, 'human'),
			),
		)
		.orderBy(asc(workspaceMembers.joinedAt))
		.limit(1)
	return owner?.actorId ?? null
}
