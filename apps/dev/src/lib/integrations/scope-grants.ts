import type { Database, Transaction } from '@maskin/db'
import { type ScopeGrant, workspaceMembers } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

/**
 * Whether every actor named by an actor grant belongs to the workspace. A workspace
 * grant names nobody and always passes; so does an empty list. One check for every
 * path that writes scope_grants, so a grant can never name an actor from another
 * workspace.
 */
export async function grantedActorsAreInWorkspace(
	db: Database | Transaction,
	workspaceId: string,
	grants: ScopeGrant[],
): Promise<boolean> {
	const actorIds = [...new Set(grants.flatMap((g) => (g.kind === 'actor' ? [g.actorId] : [])))]
	if (actorIds.length === 0) return true
	const members = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				inArray(workspaceMembers.actorId, actorIds),
			),
		)
	return members.length === actorIds.length
}
