import type { Database } from '@maskin/db'
import { events, actors, objects } from '@maskin/db/schema'
import { type DecisionDraft, commentDecisionSchema, readChanges } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { EmailAttachmentError, loadEmailAttachments, readAttachmentIds } from '../email-attachments'
import { createApiError } from '../errors'
import { findCurrentApproval } from '../object-delivery'
import { buildObjectPreview } from '../object-preview'
import { contentHash, shownDraftText } from './providers/gmail/approval-hash'
import {
	GmailSendError,
	type OutgoingEmail,
	type Recipient,
	parseRecipients,
	splitSubject,
} from './providers/gmail/send'

/**
 * Turning a person's approval into the one email it covers, for every provider that sends mail
 * (Gmail, Outlook). Moved out of the Gmail send route unchanged so there is a single approval
 * step and a single hash check: a person's tap on a card, or their approval of an email object,
 * is read back from the log, never taken from the agent's word.
 */

export type Fail = {
	status: 400 | 403 | 404 | 409 | 422 | 502
	body: ReturnType<typeof createApiError>
}

export const fail = (
	status: Fail['status'],
	code: Parameters<typeof createApiError>[0],
	message: string,
	suggestion?: string,
): Fail => ({ status, body: createApiError(code, message, undefined, suggestion) })

/** How an agent gets an email approved, worded for the send tool it will call. */
export const sendApprovalHowto = (tool: string) =>
	`This agent is set to ask first for emails. Save the email as a task or object with metadata.kind email (to, subject; the text as its content) and call this tool with object_id once a person approved it: they approve from its card, or say yes in the chat (then call approve_draft_from_chat). Or post a decision comment (create_comment with \`decision\` and the person in \`mentions\`) whose \`draft\` holds the email: \`to\` with the real address ("Mette Holm <mette@northwind.dk>"), and the text starting with a line "Subject: ..." then the body. Mark the option that sends as destructive. End your turn; when the person has chosen it, call ${tool} with approval_comment_id set to the id of your comment. For several emails on one card use \`drafts\` (each with its own \`id\`, \`to\` and Subject line) and call once per email with approval_comment_id and that email's draft_id; the person approves each with its own Send.`

export const SEND_APPROVAL_HOWTO = sendApprovalHowto('gmail_send_email')

/**
 * Whether the draft's text changed after the person's tap. Moving the task to another
 * status, changing its driver or an agent touching it does not change what they approved,
 * so only a logged change to `content` counts. Every object update logs a per-field diff.
 * A write nobody logged (the object moved on, but no event explains it) is treated as a
 * change, because then there is no way to tell.
 */
export async function textChangedAfter(
	db: Database,
	workspaceId: string,
	draftObjectId: string,
	answer: { id: number; createdAt: Date | null },
	updatedAt: Date | null,
): Promise<boolean> {
	const later = await db
		.select({ data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, draftObjectId),
				gt(events.id, answer.id),
				inArray(events.action, ['updated', 'status_changed']),
			),
		)
		.limit(100)
	for (const e of later) {
		const changes = readChanges(e.data)
		// An entry in a shape we cannot read may have touched the text.
		if (changes === null || changes.some((c) => c.field === 'content')) return true
	}
	return later.length === 0 && !!updatedAt && !!answer.createdAt && updatedAt > answer.createdAt
}

export const changedAfterApproval = () =>
	fail(
		409,
		'CONFLICT',
		'The draft was changed after the person approved it (or emptied, or their answer does not record what they saw), so this is not the text they approved. Do not send it.',
		'Post a new approval card with the current text and wait for the person to approve it again.',
	)

/** The email an approval card asks about, once a person has chosen to send it. */
export async function loadApproval(
	db: Database,
	workspaceId: string,
	callerId: string,
	approvalCommentId: number,
	draftId?: string,
	/** The send tool the agent is told to call next. */
	tool = 'gmail_send_email',
): Promise<{ email: OutgoingEmail } | { failure: Fail }> {
	const howto = sendApprovalHowto(tool)
	const [card] = await db
		.select()
		.from(events)
		.where(
			and(
				eq(events.id, approvalCommentId),
				eq(events.workspaceId, workspaceId),
				eq(events.action, 'commented'),
			),
		)
		.limit(1)
	if (!card) return { failure: fail(404, 'NOT_FOUND', 'That approval card does not exist.') }
	if (card.actorId !== callerId) {
		return { failure: fail(409, 'CONFLICT', 'That approval card was posted by someone else.') }
	}

	const decision = commentDecisionSchema.safeParse(
		(card.data as { decision?: unknown } | null)?.decision,
	)
	const stack = decision.success ? decision.data.drafts : undefined
	if (!decision.success || (!decision.data.draft && !stack?.length)) {
		return {
			failure: fail(
				409,
				'CONFLICT',
				'That comment is not an approval card with a draft attached.',
				howto,
			),
		}
	}

	let draft: DecisionDraft
	let answer: {
		id: number
		content: string | null
		createdAt: Date | null
		approvedHash: string | null
	}

	if (stack?.length) {
		// One card, several messages. Each message is approved on its own: the person's tap
		// on it is a reply "Send: <label> to <to> (<id>)", and the latest reply for THAT id
		// is its answer, whatever they did with the others.
		const ids = stack.flatMap((d) => (d.id ? [d.id] : []))
		const known = ids.length > 0 ? `Messages on this card: ${ids.join(', ')}.` : ''
		if (!draftId) {
			return {
				failure: fail(
					409,
					'CONFLICT',
					`That card carries several messages, so say which one: pass draft_id. ${known}`,
				),
			}
		}
		const picked = stack.find((d) => d.id === draftId)
		if (!picked) {
			return {
				failure: fail(
					409,
					'CONFLICT',
					`That card has no message with the id "${draftId}". ${known}`,
				),
			}
		}
		draft = picked
		const replies = await db
			.select({
				id: events.id,
				content: sql<string | null>`${events.data}->>'content'`,
				createdAt: events.createdAt,
				approvedHash: sql<string | null>`${events.data}->>'approved_send_hash'`,
			})
			.from(events)
			.innerJoin(actors, eq(actors.id, events.actorId))
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityId, card.entityId),
					eq(events.action, 'commented'),
					sql`${events.data}->>'parentEventId' = ${String(card.id)}`,
					eq(actors.type, 'human'),
				),
			)
			.orderBy(desc(events.id))
			.limit(200)
		const suffix = ` (${draftId})`
		const mine = replies.find((r) => {
			const text = r.content?.trim() ?? ''
			return (text.startsWith('Send: ') || text.startsWith('Skip: ')) && text.endsWith(suffix)
		})
		if (!mine) {
			return {
				failure: fail(
					409,
					'CONFLICT',
					'No person has answered that message yet. Do not send.',
					'End your turn and wait for them to choose.',
				),
			}
		}
		if (!mine.content?.trim().startsWith('Send: ')) {
			return {
				failure: fail(409, 'CONFLICT', 'The person skipped that message. Do not send it.'),
			}
		}
		answer = mine
	} else {
		if (draftId) {
			return {
				failure: fail(
					409,
					'CONFLICT',
					'That card carries one draft, not several. Leave out draft_id.',
				),
			}
		}
		const single = decision.data.draft
		if (!single) return { failure: fail(409, 'CONFLICT', 'That card has no draft.') }
		draft = single
		const { options } = decision.data
		const sendOptions = options.filter((o) => o.destructive)
		if (sendOptions.length !== 1 || !sendOptions[0]) {
			return {
				failure: fail(
					409,
					'CONFLICT',
					'The card must mark exactly one option as destructive: the one that sends.',
					howto,
				),
			}
		}
		const sendLabel = sendOptions[0].label

		// The person's answer: their latest reply under the card. An agent's reply never counts.
		const [latest] = await db
			.select({
				id: events.id,
				content: sql<string | null>`${events.data}->>'content'`,
				createdAt: events.createdAt,
				approvedHash: sql<string | null>`${events.data}->>'approved_send_hash'`,
			})
			.from(events)
			.innerJoin(actors, eq(actors.id, events.actorId))
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityId, card.entityId),
					eq(events.action, 'commented'),
					sql`${events.data}->>'parentEventId' = ${String(card.id)}`,
					eq(actors.type, 'human'),
				),
			)
			.orderBy(desc(events.id))
			.limit(1)
		if (!latest) {
			return {
				failure: fail(
					409,
					'CONFLICT',
					'No person has answered the approval card yet. Do not send.',
					'End your turn and wait for them to choose.',
				),
			}
		}
		if (latest.content?.trim() !== sendLabel.trim()) {
			return {
				failure: fail(
					409,
					'CONFLICT',
					`The person chose "${latest.content?.trim() ?? ''}", not "${sendLabel}". Do not send.`,
				),
			}
		}
		answer = latest
	}

	// The text is what the card shows: the draft object's current text, else the stored body.
	if (draft.object_id) {
		const [object] = await db
			.select({ content: objects.content, updatedAt: objects.updatedAt })
			.from(objects)
			.where(and(eq(objects.id, draft.object_id), eq(objects.workspaceId, workspaceId)))
			.limit(1)
		if (
			object?.content?.trim() &&
			(await textChangedAfter(db, workspaceId, draft.object_id, answer, object.updatedAt))
		) {
			return { failure: changedAfterApproval() }
		}
	}
	const text = await shownDraftText(db, workspaceId, draft)
	if (!text) {
		return { failure: fail(400, 'BAD_REQUEST', 'The approval card has no draft text.') }
	}

	const parts = splitSubject(text)
	if (!parts) {
		return {
			failure: fail(
				400,
				'BAD_REQUEST',
				'The draft must start with a line "Subject: ..." followed by the email text, so the person approved the subject too.',
				howto,
			),
		}
	}
	let to: Recipient[]
	try {
		to = parseRecipients(draft.to ?? '')
	} catch (err) {
		if (!(err instanceof GmailSendError)) throw err
		return {
			failure: fail(
				400,
				'BAD_REQUEST',
				`The card's recipient has no usable email address (${err.message}) ${howto}`,
			),
		}
	}

	// What goes out must be exactly what the person saw when they answered. Always compared,
	// also when the draft object was emptied or the answer carries no fingerprint: then there is
	// nothing to show it is the approved text, so it is not sent.
	if (
		!answer.approvedHash ||
		answer.approvedHash !== contentHash(to, [], parts.subject, parts.body)
	) {
		return { failure: changedAfterApproval() }
	}
	return { email: { to, subject: parts.subject, body: parts.body } }
}

/**
 * The email an object holds (`metadata.kind = 'email'`), and whether a person approved exactly
 * this text. The approval is the newest `approved` event a human wrote on the object, bound to
 * the content hash, so any edit to the recipients, subject or text withdraws it.
 */
export async function loadObjectEmail(
	db: Database,
	storage: StorageProvider | undefined,
	workspaceId: string,
	objectId: string,
	/** True for an agent set to always allow: the files are read even with no approval. */
	allowUnapproved: boolean,
): Promise<
	| {
			email: OutgoingEmail
			contentHash: string
			approvalEventId: number | null
			objectType: string
	  }
	| { failure: Fail }
> {
	const [object] = await db
		.select()
		.from(objects)
		.where(and(eq(objects.id, objectId), eq(objects.workspaceId, workspaceId)))
		.limit(1)
	if (!object) return { failure: fail(404, 'NOT_FOUND', 'That object does not exist.') }
	const preview = buildObjectPreview(object)
	if (!preview || preview.kind !== 'email') {
		return {
			failure: fail(
				400,
				'BAD_REQUEST',
				'That object is not an email draft. Set metadata.kind to "email", with to and subject in metadata and the text as its content.',
			),
		}
	}
	if (preview.missing.length > 0) {
		return {
			failure: fail(
				400,
				'BAD_REQUEST',
				`The draft is not complete. Missing: ${preview.missing.join(', ')}.`,
			),
		}
	}
	const metadata = (object.metadata ?? {}) as Record<string, unknown>
	const raw = (key: string) => (typeof metadata[key] === 'string' ? (metadata[key] as string) : '')
	let email: OutgoingEmail
	try {
		email = {
			to: parseRecipients(raw('to'), 'to'),
			cc: raw('cc') ? parseRecipients(raw('cc'), 'cc') : [],
			subject: preview.subject ?? '',
			body: preview.body,
		}
	} catch (err) {
		if (!(err instanceof GmailSendError)) throw err
		return { failure: fail(400, 'BAD_REQUEST', err.message) }
	}
	const approval = await findCurrentApproval(db, workspaceId, objectId, preview.content_hash)
	// Files are read only once the send can go: after a person's approval, or at once for an agent
	// set to always allow. Until then nothing is sent, so nothing is checked.
	if (approval || allowUnapproved) {
		try {
			email.attachments = await loadEmailAttachments(
				{ db, storage },
				{
					workspaceId,
					ids: readAttachmentIds(object.metadata),
					approvedAt: approval?.createdAt ?? null,
					unapproved: !approval,
				},
			)
		} catch (err) {
			if (!(err instanceof EmailAttachmentError)) throw err
			return { failure: fail(400, 'BAD_REQUEST', err.message) }
		}
	}
	return {
		email,
		contentHash: preview.content_hash,
		approvalEventId: approval?.id ?? null,
		objectType: object.type,
	}
}
