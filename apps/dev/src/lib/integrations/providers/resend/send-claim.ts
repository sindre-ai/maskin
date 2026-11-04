import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { recordEvent } from '../../../events/record-event'

/**
 * One send per approval, the way gmail/send-claim.ts does it, for a draft object: the claim
 * is taken before Resend is called, so two calls with the same approval cannot both send.
 *
 * The state lives in `events` rows on the Resend integration (`data.approval_event_id` is the
 * person's `approved` event on the draft). The latest row for an approval is its state:
 *   send_claim    → a send started; blocks every other caller
 *   sent          → Resend confirmed (written by the route, with the audit details)
 *   send_released → nothing is confirmed sent, so the same approval can be used again. For an
 *                   unclear failure that is safe because the retry carries the same
 *                   Idempotency-Key, and Resend delivers a key once.
 */
const STATES = ['send_claim', 'sent', 'send_released'] as const
export type ResendSendState = (typeof STATES)[number]

export interface ResendApprovalRef {
	workspaceId: string
	/** The Resend integration the send goes through. */
	integrationId: string
	actorId: string
	/** The id of the person's `approved` event on the draft (events.id). */
	approvalEventId: number
}

const stateFilter = (ref: ResendApprovalRef) =>
	and(
		eq(events.workspaceId, ref.workspaceId),
		eq(events.entityId, ref.integrationId),
		sql`${events.data}->>'approval_event_id' = ${String(ref.approvalEventId)}`,
		inArray(sql`${events.data}->>'resend_action'`, [...STATES]),
	)

export async function claimResendApproval(db: Database, ref: ResendApprovalRef): Promise<boolean> {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`resend-send:${ref.integrationId}:${ref.approvalEventId}`}))`,
		)
		const [latest] = await tx
			.select({ action: sql<string>`${events.data}->>'resend_action'` })
			.from(events)
			.where(stateFilter(ref))
			.orderBy(desc(events.id))
			.limit(1)
		if (latest && latest.action !== 'send_released') return false
		await recordEvent(tx, {
			workspaceId: ref.workspaceId,
			actorId: ref.actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: ref.integrationId,
			data: {
				provider: 'resend',
				resend_action: 'send_claim',
				approval_event_id: ref.approvalEventId,
			},
		})
		return true
	})
}

/** The state an approval is in now, or null if it was never used. For a clear refusal message. */
export async function resendApprovalState(
	db: Database,
	ref: ResendApprovalRef,
): Promise<ResendSendState | null> {
	const [latest] = await db
		.select({ action: sql<ResendSendState>`${events.data}->>'resend_action'` })
		.from(events)
		.where(stateFilter(ref))
		.orderBy(desc(events.id))
		.limit(1)
	return latest?.action ?? null
}

/** Resend did not confirm the send, so the approval can be tried again under the same key. */
export async function releaseResendApproval(db: Database, ref: ResendApprovalRef): Promise<void> {
	await recordEvent(db, {
		workspaceId: ref.workspaceId,
		actorId: ref.actorId,
		action: 'updated',
		entityType: 'integration',
		entityId: ref.integrationId,
		data: {
			provider: 'resend',
			resend_action: 'send_released',
			approval_event_id: ref.approvalEventId,
		},
	})
}
