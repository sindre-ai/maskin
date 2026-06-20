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
 * Return only the actor IDs that are members of the given workspace.
 * One query with `inArray` instead of N per-actor lookups — use when a write
 * route must validate a caller-supplied list of actors against the workspace
 * (e.g. participant seating on /api/conversations) before committing.
 *
 * Preserves caller order, deduplicates input, and returns `[]` for an empty
 * input without hitting the DB. Returns the IDs that ARE members; the caller
 * computes the non-member diff from its own input.
 */
export async function filterWorkspaceMembers(
	db: Database,
	actorIds: readonly string[],
	workspaceId: string,
): Promise<string[]> {
	const unique = Array.from(new Set(actorIds))
	if (unique.length === 0) return []
	const rows = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.actorId, unique)),
		)
	const found = new Set(rows.map((r) => r.actorId))
	return unique.filter((id) => found.has(id))
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
