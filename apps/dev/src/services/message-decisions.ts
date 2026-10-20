import type { Database } from '@maskin/db'
import { actors, messageDecisions, workspaceMembers } from '@maskin/db/schema'
import { CHIEF_OF_STAFF_DEFAULT } from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'

export type MessageDecisionState = {
	status: 'open' | 'answered' | 'withdrawn'
	forActorIds: string[]
	attention: number | null
	answerOptionIndex: number | null
	answeredBy: string | null
	answeredAt: string | null
	withdrawnReason: string | null
}

/** Where each decision card on a page of messages stands. */
export async function loadDecisionsByMessage(
	db: Database,
	messageIds: number[],
): Promise<Map<number, MessageDecisionState>> {
	const out = new Map<number, MessageDecisionState>()
	if (messageIds.length === 0) return out
	const rows = await db
		.select()
		.from(messageDecisions)
		.where(inArray(messageDecisions.messageId, messageIds))
	for (const r of rows) {
		out.set(r.messageId, {
			status: r.status as MessageDecisionState['status'],
			forActorIds: r.forActorIds,
			attention: r.attention,
			answerOptionIndex: r.answerOptionIndex,
			answeredBy: r.answeredBy,
			answeredAt: r.answeredAt?.toISOString() ?? null,
			withdrawnReason: r.withdrawnReason,
		})
	}
	return out
}

/**
 * Only the Chief of Staff curates other agents' decisions: the built-in system agent of that
 * name, in this workspace. Anyone else asking gets a 403, so agents cannot withdraw each
 * other's questions.
 */
export async function isChiefOfStaff(
	db: Database,
	workspaceId: string,
	actorId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(
			workspaceMembers,
			and(eq(workspaceMembers.actorId, actors.id), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.where(
			and(
				eq(actors.id, actorId),
				eq(actors.type, 'agent'),
				eq(actors.isSystem, true),
				eq(actors.name, CHIEF_OF_STAFF_DEFAULT.name),
			),
		)
		.limit(1)
	return Boolean(row)
}
