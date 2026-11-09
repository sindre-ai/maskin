import type { Database } from '@maskin/db'
import { apiKeys, sessions } from '@maskin/db/schema'
import { and, eq, inArray, max } from 'drizzle-orm'

/**
 * When each member was last active, for the Members table.
 *
 * Nothing is written for this. A person's time is the newest last_used_at across their API keys,
 * which the auth check already stamps (at most once per cache window, see validateApiKey), so it
 * is account-wide, not per workspace. An agent's time is its newest session in this workspace.
 * A member with no keys or no sessions is left out of the map.
 */
export async function loadMembersLastActive(
	db: Database,
	workspaceId: string,
	members: { actorId: string; type: string }[],
): Promise<Map<string, Date>> {
	const lastActive = new Map<string, Date>()
	const agentIds = members.filter((m) => m.type === 'agent').map((m) => m.actorId)
	const humanIds = members.filter((m) => m.type !== 'agent').map((m) => m.actorId)

	const [keyRows, sessionRows] = await Promise.all([
		humanIds.length === 0
			? []
			: db
					.select({ actorId: apiKeys.actorId, at: max(apiKeys.lastUsedAt) })
					.from(apiKeys)
					.where(inArray(apiKeys.actorId, humanIds))
					.groupBy(apiKeys.actorId),
		agentIds.length === 0
			? []
			: db
					.select({ actorId: sessions.actorId, at: max(sessions.createdAt) })
					.from(sessions)
					.where(and(eq(sessions.workspaceId, workspaceId), inArray(sessions.actorId, agentIds)))
					.groupBy(sessions.actorId),
	])
	for (const row of [...keyRows, ...sessionRows]) {
		if (row.at) lastActive.set(row.actorId, row.at)
	}
	return lastActive
}
