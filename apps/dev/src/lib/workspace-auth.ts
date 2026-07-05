import type { Database } from '@maskin/db'
import { workspaceMembers } from '@maskin/db/schema'
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
 * Check if two actors share at least one workspace. Used by by-ID actor
 * routes (e.g. viewing another actor's profile) that have no explicit
 * X-Workspace-Id header to check against but still must not leak actor data
 * across tenants who share no workspace.
 */
export async function shareWorkspace(
	db: Database,
	actorIdA: string,
	actorIdB: string,
): Promise<boolean> {
	const workspacesOfA = db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, actorIdA))

	const [shared] = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, actorIdB),
				inArray(workspaceMembers.workspaceId, workspacesOfA),
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
