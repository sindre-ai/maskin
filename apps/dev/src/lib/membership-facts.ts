import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { and, count, eq, inArray, ne } from 'drizzle-orm'
import type { MembershipFacts } from './account-deletion'

/**
 * The workspaces `actorId` belongs to (optionally just one), with what account and workspace
 * deletion need to decide: who pays, how many other people are in it, and whether a plan is live.
 */
export async function loadMembershipFacts(
	db: Database,
	actorId: string,
	onlyWorkspaceId?: string,
): Promise<MembershipFacts[]> {
	const mine = await db
		.select({
			workspaceId: workspaces.id,
			workspaceName: workspaces.name,
			billingOwnerId: workspaces.billingOwnerId,
			settings: workspaces.settings,
		})
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(
			onlyWorkspaceId
				? and(eq(workspaceMembers.actorId, actorId), eq(workspaces.id, onlyWorkspaceId))
				: eq(workspaceMembers.actorId, actorId),
		)
	if (mine.length === 0) return []

	const others = await db
		.select({ workspaceId: workspaceMembers.workspaceId, n: count() })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				inArray(
					workspaceMembers.workspaceId,
					mine.map((m) => m.workspaceId),
				),
				eq(actors.type, 'human'),
				ne(workspaceMembers.actorId, actorId),
			),
		)
		.groupBy(workspaceMembers.workspaceId)
	const otherCount = new Map(others.map((o) => [o.workspaceId, Number(o.n)]))

	return mine.map((m) => {
		const settings = m.settings as { billing?: MembershipFacts['billing'] } | null
		const billing = settings?.billing
		return {
			workspaceId: m.workspaceId,
			workspaceName: m.workspaceName,
			billingOwnerId: m.billingOwnerId,
			otherHumanMembers: otherCount.get(m.workspaceId) ?? 0,
			billing: billing && typeof billing === 'object' ? billing : null,
		}
	})
}
