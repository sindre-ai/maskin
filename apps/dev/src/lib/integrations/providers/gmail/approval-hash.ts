import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { type DecisionDraft, commentDecisionSchema } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { type Recipient, parseRecipients, splitSubject } from './send'

/**
 * A fingerprint of exactly what an email says: who it goes to, the subject and the body.
 *
 * It is stamped on the person's reply when they answer an approval card (`approved_send_hash`),
 * from the text the card showed them at that moment, and compared at send time with what is
 * about to go out. So an approval covers one text, not "whatever the draft object holds when
 * the agent gets round to sending".
 */
export const contentHash = (to: Recipient[], cc: Recipient[], subject: string, body: string) =>
	createHash('sha256')
		.update(
			JSON.stringify([
				to.map((r) => r.address).sort(),
				cc.map((r) => r.address).sort(),
				subject,
				body,
			]),
		)
		.digest('hex')

/** The text a card shows for a draft: the draft object's current text, else the stored body. */
export async function shownDraftText(
	db: Database,
	workspaceId: string,
	draft: DecisionDraft,
): Promise<string | undefined> {
	if (draft.object_id) {
		const [object] = await db
			.select({ content: objects.content })
			.from(objects)
			.where(and(eq(objects.id, draft.object_id), eq(objects.workspaceId, workspaceId)))
			.limit(1)
		if (object?.content?.trim()) return object.content
	}
	return draft.body?.trim() ? draft.body : undefined
}

/** The fingerprint of the email a draft would send now, or null when it would not be sendable. */
export async function shownDraftHash(
	db: Database,
	workspaceId: string,
	draft: DecisionDraft,
): Promise<string | null> {
	const text = await shownDraftText(db, workspaceId, draft)
	const parts = text ? splitSubject(text) : null
	if (!parts) return null
	try {
		return contentHash(parseRecipients(draft.to ?? ''), [], parts.subject, parts.body)
	} catch {
		return null
	}
}

/**
 * When `cardEventId` is a decision card with an email draft, the fingerprint of the draft as it
 * reads right now, for the reply that answers it (a stacked card's reply ends in " (<draft id>)").
 * gmail_send_email refuses to send anything that does not match it.
 */
export async function approvedSendHashFor(
	db: Database,
	workspaceId: string,
	cardEventId: number,
	reply: string,
): Promise<string | undefined> {
	const [card] = await db
		.select({ data: events.data })
		.from(events)
		.where(
			and(
				eq(events.id, cardEventId),
				eq(events.workspaceId, workspaceId),
				eq(events.action, 'commented'),
			),
		)
		.limit(1)
	const decision = commentDecisionSchema.safeParse(
		(card?.data as { decision?: unknown } | null)?.decision,
	)
	if (!decision.success) return undefined
	const { draft, drafts } = decision.data
	const answered = drafts?.length
		? drafts.find((d) => d.id && reply.trim().endsWith(` (${d.id})`))
		: draft
	if (!answered) return undefined
	return (await shownDraftHash(db, workspaceId, answered)) ?? undefined
}
