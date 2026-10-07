import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

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

/**
 * Whether `callerId` may reach `targetId` through a workspace they both belong
 * to: the caller itself, or two members of one workspace. When `workspaceId`
 * is given (the X-Workspace-Id header) the shared workspace must be that one.
 * By-ID actor routes use this so a member of workspace A cannot read or edit an
 * actor that only lives in workspace B.
 */
export async function actorsShareWorkspace(
	db: Database,
	callerId: string,
	targetId: string,
	workspaceId?: string,
): Promise<boolean> {
	if (callerId === targetId) return true
	if (workspaceId) {
		return (
			(await isWorkspaceMember(db, callerId, workspaceId)) &&
			(await isWorkspaceMember(db, targetId, workspaceId))
		)
	}
	const callerWorkspaces = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, callerId))
	if (callerWorkspaces.length === 0) return false
	const [shared] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, targetId),
				inArray(
					workspaceMembers.workspaceId,
					callerWorkspaces.map((w) => w.workspaceId),
				),
			),
		)
		.limit(1)
	return !!shared
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
