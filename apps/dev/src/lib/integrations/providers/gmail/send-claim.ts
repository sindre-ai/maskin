import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'

/**
 * One send per approved draft. The claim is a single conditional UPDATE, so of any number
 * of simultaneous callers exactly one gets it: the draft must still be approved (an
 * Undo wins over a send that has not started) and must never have been claimed before.
 *
 * States kept in the task's flat metadata, next to the card's own `draft_*` keys:
 *   sending → set by the claim, before Gmail is called
 *   sent    → Gmail confirmed
 *   unknown → Gmail may or may not have sent; stays locked until a person looks
 * A refusal from Gmail (nothing sent) releases the claim so the draft can be tried again.
 */
export async function claimDraftForSend(db: Database, draftObjectId: string): Promise<boolean> {
	const claimed = await db
		.update(objects)
		.set({
			metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) || '{"draft_send_state":"sending"}'::jsonb`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(objects.id, draftObjectId),
				sql`${objects.metadata}->>'draft_state' = 'approved'`,
				sql`${objects.metadata}->>'draft_send_state' is null`,
			),
		)
		.returning({ id: objects.id })
	return claimed.length > 0
}

export type DraftSendOutcome =
	| { state: 'released' }
	| { state: 'unknown' }
	| { state: 'sent'; sentAt: string; messageId: string }

export async function settleDraftSend(
	db: Database,
	draftObjectId: string,
	outcome: DraftSendOutcome,
): Promise<void> {
	const metadata =
		outcome.state === 'released'
			? sql`${objects.metadata} - 'draft_send_state'`
			: outcome.state === 'unknown'
				? sql`${objects.metadata} || '{"draft_send_state":"unknown"}'::jsonb`
				: sql`${objects.metadata} || ${JSON.stringify({
						draft_send_state: 'sent',
						draft_sent_at: outcome.sentAt,
						draft_sent_message_id: outcome.messageId,
					})}::jsonb`
	await db
		.update(objects)
		.set({ metadata, updatedAt: new Date() })
		.where(eq(objects.id, draftObjectId))
}
