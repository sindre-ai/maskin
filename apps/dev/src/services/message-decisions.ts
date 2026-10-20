import type { Database } from '@maskin/db'
import { messageDecisions } from '@maskin/db/schema'
import { inArray } from 'drizzle-orm'

export type MessageDecisionState = {
	status: 'open' | 'answered' | 'withdrawn'
	forActorIds: string[]
	attention: number | null
	answerOptionIndex: number | null
	answeredBy: string | null
	answeredAt: string | null
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
		})
	}
	return out
}
