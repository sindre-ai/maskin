import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { type ObjectPreview, parseCommentDecision } from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { findCurrentApproval } from './object-delivery'
import { buildObjectPreview } from './object-preview'

/**
 * Which drafts a person approved by answering a decision card.
 *
 * Choosing the send option on a card is the person's yes to the draft behind it, and every
 * client says it the same way: a reply under the card. Reading it here means web, the native
 * apps and any future client approve a draft without each learning a second call, and the
 * approval exists before the agent is woken by the reply.
 *
 *  - A card with one `draft`: the reply is the label of its one destructive option.
 *  - A card with several `drafts`: the reply is "Send: <label> to <to> (<id>)", one per message.
 *
 * Only a draft that is an object an integration can send (it has a preview), is complete, and
 * has no approval of its current text yet is returned.
 */

export interface ReplyApproval {
	objectId: string
	objectType: string
	preview: ObjectPreview
	/** The decision comment that was answered. */
	cardEventId: number
}

export async function resolveReplyApprovals(
	db: Database,
	params: {
		workspaceId: string
		entityId: string
		parentEventId: number | undefined
		content: string
	},
): Promise<ReplyApproval[]> {
	if (params.parentEventId === undefined) return []
	const reply = params.content.trim()
	if (!reply) return []

	const [card] = await db
		.select({ id: events.id, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.id, params.parentEventId),
				eq(events.workspaceId, params.workspaceId),
				eq(events.entityId, params.entityId),
				eq(events.action, 'commented'),
			),
		)
		.limit(1)
	const decision = parseCommentDecision((card?.data as { decision?: unknown } | null)?.decision)
	if (!card || !decision) return []

	// The draft object ids this reply says yes to.
	const approved: string[] = []
	if (decision.drafts?.length) {
		if (!reply.startsWith('Send: ')) return []
		for (const draft of decision.drafts) {
			if (draft.object_id && draft.id && reply.endsWith(` (${draft.id})`)) {
				approved.push(draft.object_id)
			}
		}
	} else if (decision.draft?.object_id) {
		const sends = decision.options.filter((o) => o.destructive)
		if (sends.length === 1 && sends[0]?.label.trim() === reply)
			approved.push(decision.draft.object_id)
	}
	if (approved.length === 0) return []

	const rows = await db
		.select()
		.from(objects)
		.where(and(eq(objects.workspaceId, params.workspaceId), inArray(objects.id, approved)))

	const result: ReplyApproval[] = []
	for (const row of rows) {
		const preview = buildObjectPreview(row)
		if (!preview || preview.missing.length > 0) continue
		// Already approved at exactly this text (the web's Approve call came first): nothing to add.
		if (await findCurrentApproval(db, params.workspaceId, row.id, preview.content_hash)) continue
		result.push({ objectId: row.id, objectType: row.type, preview, cardEventId: Number(card.id) })
	}
	return result
}
