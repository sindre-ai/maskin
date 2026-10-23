import type { Database, Transaction } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * Name of the Chief of Staff agent seeded into every workspace at creation —
 * the actor of last resort for case 3 dispatch when a commented object has no
 * driver (or the only candidate driver is the comment author). Load-bearing
 * per spec — see `always-a-responder-rule-shaping.md` §Solution sketch case 3.
 *
 * Resolved per workspace, NOT hardcoded to one actor id. Every workspace gets
 * its own Chief of Staff row at creation and keeps it for the workspace's
 * lifetime, so a single global id is only ever correct in the one workspace it
 * came from — everywhere else case 3 dispatched to a nonexistent actor and
 * failed inside `dispatchCommentFallback`'s catch, silently. Resolution
 * mirrors `lib/onboarding/signup-welcome.ts`'s `resolveAgentIdByName`, which
 * is how the same agent is already located at signup.
 */
export const CHIEF_OF_STAFF_NAME = 'Chief of Staff'

/**
 * Resolves the workspace's own Chief of Staff. Matched on name + agent type
 * through `workspace_members`, the same way `signup-welcome.ts` locates it.
 * Oldest membership wins so the answer is stable for the workspace's
 * lifetime if a second same-named agent is ever added.
 */
export async function findChiefOfStaffId(
	db: Database | Transaction,
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
		.orderBy(actors.createdAt)
		.limit(1)
	return row?.actorId ?? null
}
