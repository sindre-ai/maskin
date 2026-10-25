import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { recordEvent } from '../../../events/record-event'

/**
 * One send per approval. A person's tap on a decision card is one yes, and it covers one
 * email: the claim is taken before Gmail is called, so two calls with the same approval
 * cannot both send.
 *
 * The state lives in `events` rows on the Gmail integration (`data.approval_comment_id`
 * names the card), because the draft behind a card is not always an object that could hold
 * a flag. The latest row for an approval is its state:
 *   send_claim    → a send started; blocks every other caller
 *   sent          → Gmail confirmed (written by the route, with the audit details)
 *   send_unknown  → Gmail may or may not have sent; stays locked until a person looks
 *   send_released → Gmail refused it (nothing sent), so the same approval can be used again
 *
 * Callers of one approval are serialised with a transaction-scoped advisory lock, so the
 * read of the latest state and the insert of the claim cannot interleave.
 */
const STATES = ['send_claim', 'sent', 'send_unknown', 'send_released'] as const
export type ApprovalSendState = (typeof STATES)[number]

export interface ApprovalRef {
	workspaceId: string
	/** The Gmail integration the send goes through. */
	integrationId: string
	actorId: string
	/** The id of the decision comment (events.id) the person answered. */
	approvalCommentId: number
	/** One message of a card that carries several (`decision.drafts[].id`). Each is its own approval. */
	draftId?: string
}

const stateFilter = (ref: ApprovalRef) =>
	and(
		eq(events.workspaceId, ref.workspaceId),
		eq(events.entityId, ref.integrationId),
		sql`${events.data}->>'approval_comment_id' = ${String(ref.approvalCommentId)}`,
		// A card with one draft has no draft id; a stacked card's messages each have one.
		ref.draftId === undefined
			? sql`${events.data}->>'approval_draft_id' is null`
			: sql`${events.data}->>'approval_draft_id' = ${ref.draftId}`,
		inArray(sql`${events.data}->>'gmail_action'`, [...STATES]),
	)

export async function claimApprovalForSend(db: Database, ref: ApprovalRef): Promise<boolean> {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`gmail-send:${ref.integrationId}:${ref.approvalCommentId}:${ref.draftId ?? ''}`}))`,
		)
		const [latest] = await tx
			.select({ action: sql<string>`${events.data}->>'gmail_action'` })
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
				provider: 'gmail',
				gmail_action: 'send_claim',
				approval_comment_id: ref.approvalCommentId,
				...(ref.draftId === undefined ? {} : { approval_draft_id: ref.draftId }),
			},
		})
		return true
	})
}

/** The state an approval is in now, or null if it was never used. For a clear refusal message. */
export async function approvalSendState(
	db: Database,
	ref: ApprovalRef,
): Promise<ApprovalSendState | null> {
	const [latest] = await db
		.select({ action: sql<ApprovalSendState>`${events.data}->>'gmail_action'` })
		.from(events)
		.where(stateFilter(ref))
		.orderBy(desc(events.id))
		.limit(1)
	return latest?.action ?? null
}

/** Gmail refused it or the outcome is unknown. A confirmed send is recorded by the route. */
export async function settleApprovalSend(
	db: Database,
	ref: ApprovalRef,
	outcome: 'released' | 'unknown',
): Promise<void> {
	await recordEvent(db, {
		workspaceId: ref.workspaceId,
		actorId: ref.actorId,
		action: 'updated',
		entityType: 'integration',
		entityId: ref.integrationId,
		data: {
			provider: 'gmail',
			gmail_action: outcome === 'released' ? 'send_released' : 'send_unknown',
			approval_comment_id: ref.approvalCommentId,
			...(ref.draftId === undefined ? {} : { approval_draft_id: ref.draftId }),
		},
	})
}
