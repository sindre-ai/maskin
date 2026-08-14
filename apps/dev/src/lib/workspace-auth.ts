import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * Check if an actor is a member of a workspace.
 *
 * Workspace membership is enforced at two layers:
 * 1. authMiddleware — checks membership when the X-Workspace-Id header is present (list routes).
 * 2. This helper — checks membership on by-ID routes (GET/PATCH/DELETE /:id) where the workspace
 *    is derived from the resource itself, not the header. Both layers are intentional: the middleware
 *    guards header-scoped requests, while this helper guards resource-scoped requests.
 */
export async function isWorkspaceMember(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<boolean> {
	const [member] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.actorId, actorId), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.limit(1)
	return !!member
}

export async function isWorkspaceOwner(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<boolean> {
	const [member] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, actorId),
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.role, 'owner'),
			),
		)
		.limit(1)
	return !!member
}

// Human admin/owner check for surfaces where only workspace humans can act
// (e.g. the T5 "Verified by <human>" stamp on Knowledge Author writes).
// Agents must not pass — even if they somehow held an admin/owner membership,
// stamping is an object-level human verification, not an autonomous action.
export async function isWorkspaceHumanAdminOrOwner(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ role: workspaceMembers.role, type: actors.type })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(eq(workspaceMembers.actorId, actorId), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.limit(1)
	if (!row) return false
	if (row.type === 'agent') return false
	return row.role === 'owner' || row.role === 'admin'
}
