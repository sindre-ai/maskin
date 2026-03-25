import type { Database } from '@ai-native/db'
import { workspaceMembers } from '@ai-native/db/schema'
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
