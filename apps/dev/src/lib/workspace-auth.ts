import type { Database } from '@ai-native/db'
import { workspaceMembers } from '@ai-native/db/schema'
import { and, eq } from 'drizzle-orm'

/** Check if an actor is a member of a workspace. Used by by-ID routes where X-Workspace-Id header is not present. */
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
