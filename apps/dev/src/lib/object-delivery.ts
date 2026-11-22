import type { Database, Transaction } from '@maskin/db'
import { events, actors } from '@maskin/db/schema'
import type { ObjectPreview } from '@maskin/shared'
import { and, desc, eq } from 'drizzle-orm'
import { withAttachmentNames } from './email-attachments'
import { recordEventReturning } from './events/record-event'

/**
 * Where a draft stands, read from the object's own `events` log, so nothing about it is
 * stored twice and an edit un-approves by itself.
 *
 *   approved   a person (never an agent) approved exactly this content hash. The newest
 *              such event wins, so approving again after an edit replaces the old one.
 *   delivered  an integration sent this object. Shown whatever the hash is now (see
 *              withDeliveryState).
 *
 * Both events carry `data.content_hash`. A change to the recipients, subject or text
 * changes the hash, which is why an approval needs no "was it edited since?" scan.
 */

export const APPROVED_ACTION = 'approved'
export const DELIVERED_ACTION = 'delivered'
export const AUTO_SENT_ACTION = 'auto_sent'

export interface ObjectApproval {
	/** The id of the approval event. Send claims are keyed on it: one approval, one send. */
	id: number
	actorId: string | null
	createdAt: Date | null
}

async function latestEvent(
	db: Database,
	workspaceId: string,
	objectId: string,
	action: string,
	humanOnly: boolean,
) {
	const rows = await db
		.select({
			id: events.id,
			actorId: events.actorId,
			createdAt: events.createdAt,
			hash: events.data,
		})
		.from(events)
		.innerJoin(actors, eq(actors.id, events.actorId))
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, objectId),
				eq(events.action, action),
				...(humanOnly ? [eq(actors.type, 'human')] : []),
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	const row = rows[0]
	if (!row) return null
	const data = (row.hash ?? {}) as { content_hash?: unknown }
	return {
		id: Number(row.id),
		actorId: row.actorId,
		createdAt: row.createdAt,
		contentHash: typeof data.content_hash === 'string' ? data.content_hash : null,
	}
}

/** True when any integration has recorded a send on this object, whatever its content. */
export async function hasDelivered(
	db: Database,
	workspaceId: string,
	objectId: string,
): Promise<boolean> {
	return (await latestEvent(db, workspaceId, objectId, DELIVERED_ACTION, false)) !== null
}

/** The person's approval of exactly this content, or null when there is none. */
export async function findCurrentApproval(
	db: Database,
	workspaceId: string,
	objectId: string,
	contentHash: string,
): Promise<ObjectApproval | null> {
	const latest = await latestEvent(db, workspaceId, objectId, APPROVED_ACTION, true)
	if (!latest || latest.contentHash !== contentHash) return null
	return { id: latest.id, actorId: latest.actorId, createdAt: latest.createdAt }
}

/** ", 18 Nov 2026" for the line that says an agent sent a draft; empty when the time is unknown. */
function formatSentDate(at: Date | null): string {
	if (!at) return ''
	return `, ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
}

/** Adds `delivery` to a preview: draft, approved, or sent. */
export async function withDeliveryState(
	db: Database,
	workspaceId: string,
	objectId: string,
	basePreview: ObjectPreview,
): Promise<ObjectPreview> {
	// File names for display; the hash was computed from the ids and stays as it is.
	const preview = await withAttachmentNames(db, workspaceId, basePreview)
	// Any delivery on the object counts, whatever its hash. The hash covers the detail lines
	// read from metadata (a post's "Scheduled" date is dropped when it goes live), so it can
	// change after a send without anyone editing the text. A sent object stays sent, which is
	// also what hasDelivered and assertSendable already enforce.
	const delivered = await latestEvent(db, workspaceId, objectId, DELIVERED_ACTION, false)
	if (delivered) {
		// An agent on Always allow sent this text with no person in between: say so on the card.
		// It is a detail line added after the hash was computed, so it never changes an approval
		// and every client that draws details (web, chat, For You, iOS) shows it.
		const auto = await latestEvent(db, workspaceId, objectId, AUTO_SENT_ACTION, false)
		const details =
			auto && auto.contentHash === delivered.contentHash
				? [
						...preview.details,
						{
							label: 'Sent',
							value: `By the agent, no approval needed${formatSentDate(delivered.createdAt)}`,
						},
					]
				: preview.details
		return {
			...preview,
			details,
			delivery: { state: 'sent', at: delivered.createdAt?.toISOString() ?? null },
		}
	}
	const approval = await findCurrentApproval(db, workspaceId, objectId, preview.content_hash)
	return {
		...preview,
		delivery: approval
			? { state: 'approved', at: approval.createdAt?.toISOString() ?? null }
			: { state: 'draft', at: null },
	}
}

/**
 * Writes a person's approval of a draft, bound to the content hash they approved. The one
 * place an `approved` event is created, so the route a button calls and a reply to a
 * decision card leave the same record behind.
 *
 * `via` says how the person said yes: `approval` (the Approve button, which names the hash
 * the person saw), `reply` (they chose the send option on a card, so the hash is the text
 * as it read at that moment) or `chat` (they said yes in a chat message, which the server
 * checked in chat-approval.ts; `chat` names the message, the chat and the agent that asked).
 */
export async function recordObjectApproval(
	db: Database | Transaction,
	params: {
		workspaceId: string
		actorId: string
		objectId: string
		objectType: string
		preview: Pick<ObjectPreview, 'content_hash' | 'kind'>
		via: 'approval' | 'reply' | 'chat'
		/** The decision comment the person answered, when `via` is `reply`. */
		replyToEventId?: number
		/** The message that counted as the yes, when `via` is `chat`. Kept for the audit trail. */
		chat?: { messageId: number; conversationId: string; agentId: string }
	},
) {
	return recordEventReturning(db, {
		workspaceId: params.workspaceId,
		actorId: params.actorId,
		action: APPROVED_ACTION,
		entityType: params.objectType,
		entityId: params.objectId,
		data: {
			content_hash: params.preview.content_hash,
			kind: params.preview.kind,
			via: params.via,
			...(params.replyToEventId === undefined ? {} : { reply_to_event_id: params.replyToEventId }),
			...(params.chat
				? {
						chat_message_id: params.chat.messageId,
						conversation_id: params.chat.conversationId,
						requested_by_agent_id: params.chat.agentId,
					}
				: {}),
		},
	})
}
