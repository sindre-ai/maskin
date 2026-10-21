import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, objects } from '@maskin/db/schema'
import { type DecisionDraft, commentDecisionSchema, readChanges } from '@maskin/shared'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { canWrite, resolveAgentAccess } from '../lib/integrations/agent-access'
import { IntegrationAuthRevokedError, ScopeDeniedError } from '../lib/integrations/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { contentHash, shownDraftText } from '../lib/integrations/providers/gmail/approval-hash'
import {
	GmailSendError,
	type OutgoingEmail,
	type Recipient,
	parseRecipients,
	sendEmail,
	splitSubject,
} from '../lib/integrations/providers/gmail/send'
import {
	type ApprovalRef,
	approvalSendState,
	claimApprovalForSend,
	settleApprovalSend,
} from '../lib/integrations/providers/gmail/send-claim'
import { readContextFor } from '../lib/integrations/read-context'
import { getProvider } from '../lib/integrations/registry'
import { accessDeniedMessage } from '../lib/integrations/tool-gate'
import { logger } from '../lib/logger'
import { DELIVERED_ACTION, findCurrentApproval } from '../lib/object-delivery'
import { buildObjectPreview } from '../lib/object-preview'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { recordSendOutcome } from '../lib/send-closure'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'

/**
 * Send an email from the workspace's connected Gmail. Behind the `gmail_send_email`
 * MCP tool: Google's hosted Gmail tool can only create drafts.
 *
 * Who may send, in one place. Reading and drafting need Read or Read & write; sending needs
 * Read & write AND a person's approval of that exact email, every time (Settings → Integrations).
 * Read, or no access, cannot send at all. An agent never sends an email on its own, so there is
 * no "direct" send and no per-recipient exception to make: a person looked at every email.
 *
 * "Approve" is the For You decision card: the agent posts a comment with a `decision` whose
 * `draft` holds the email and whose one destructive option is the send, and a person taps it.
 * That tap is stored as a reply comment under the card, written by a person. This route reads
 * it back instead of trusting the agent's word that it happened:
 *  - the card must be the caller's own, and a person (never an agent) must have answered it
 *    with the send option, as their latest answer;
 *  - what goes out is the draft as the card shows it. If the draft object was changed after the
 *    person answered, nothing is sent, because they approved different text;
 *  - one approval sends one email, claimed before Gmail is called.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		workspaceRole?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const TOOL_NAME = 'gmail_send_email'

const sendBodySchema = z
	.object({
		to: z.string().min(1).max(2000).optional(),
		cc: z.string().max(2000).optional(),
		subject: z.string().min(1).max(998).optional(),
		body: z.string().min(1).max(100_000).optional(),
		approval_comment_id: z.number().int().positive().optional(),
		draft_id: z.string().min(1).max(40).optional(),
		object_id: z.string().uuid().optional(),
	})
	.refine(
		(v) => {
			if (v.object_id) {
				return !v.approval_comment_id && !v.draft_id && !v.to && !v.cc && !v.subject && !v.body
			}
			return v.approval_comment_id
				? !v.to && !v.cc && !v.subject && !v.body
				: Boolean(v.to && v.subject && v.body)
		},
		{
			message:
				'Pass object_id (to send the email an object holds), approval_comment_id (to send an email a person approved on a card) or to, subject and body (to send a new email). Not a mix.',
		},
	)
	.refine((v) => !v.draft_id || v.approval_comment_id, {
		message: 'draft_id only goes with approval_comment_id.',
	})

const sendRoute = createRoute({
	method: 'post',
	path: '/send',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Send an email from the connected Gmail account',
	description:
		'Irreversible and never retried. Needs "Read & write" access and an email a person approved: an object draft they approved (object_id) or an approval card they answered (approval_comment_id).',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: sendBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: 'Sent',
			content: {
				'application/json': {
					schema: z.object({
						message_id: z.string(),
						thread_id: z.string().nullable(),
						mode: z.literal('approved_draft'),
					}),
				},
			},
		},
		400: { description: 'Invalid', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: { description: 'Conflict', content: { 'application/json': { schema: errorSchema } } },
		422: { description: 'Refused', content: { 'application/json': { schema: errorSchema } } },
		502: { description: 'Gmail error', content: { 'application/json': { schema: errorSchema } } },
	},
})

type Fail = {
	status: 400 | 403 | 404 | 409 | 422 | 502
	body: ReturnType<typeof createApiError>
}

const fail = (
	status: Fail['status'],
	code: Parameters<typeof createApiError>[0],
	message: string,
	suggestion?: string,
): Fail => ({ status, body: createApiError(code, message, undefined, suggestion) })

/** The workspace's Gmail login, read through Keychain so the read is gated and audited. */
const readGmailCredential = (db: Database, workspaceId: string, actorId: string) =>
	getIntegrationCredential(db, workspaceId, 'gmail', actorId, {
		fallbackToAnyActor: true,
		ctx: readContextFor(actorId, 'gmail:send'),
	})

function sendFailureFor(err: GmailSendError): Fail {
	switch (err.code) {
		case 'INVALID_EMAIL':
			return fail(400, 'BAD_REQUEST', err.message)
		case 'RECONSENT_REQUIRED':
		case 'INSUFFICIENT_SCOPE':
			return fail(409, 'CONFLICT', err.message)
		case 'REJECTED':
			return fail(422, 'BAD_REQUEST', err.message)
		default:
			return fail(502, 'INTERNAL_ERROR', err.message)
	}
}

const SEND_APPROVAL_HOWTO =
	'Post a decision comment (create_comment with `decision` and the person in `mentions`) whose `draft` holds the email: `to` with the real address ("Mette Holm <mette@northwind.dk>"), and the text starting with a line "Subject: ..." then the body. Mark the option that sends as destructive. End your turn; when the person has chosen it, call gmail_send_email with approval_comment_id set to the id of your comment. For several emails on one card use `drafts` (each with its own `id`, `to` and Subject line) and call once per email with approval_comment_id and that email\'s draft_id; the person approves each with its own Send.'

/**
 * Whether the draft's text changed after the person's tap. Moving the task to another
 * status, changing its driver or an agent touching it does not change what they approved,
 * so only a logged change to `content` counts. Every object update logs a per-field diff.
 * A write nobody logged (the object moved on, but no event explains it) is treated as a
 * change, because then there is no way to tell.
 */
async function textChangedAfter(
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

const changedAfterApproval = () =>
	fail(
		409,
		'CONFLICT',
		'The draft was changed after the person approved it (or emptied, or their answer does not record what they saw), so this is not the text they approved. Do not send it.',
		'Post a new approval card with the current text and wait for the person to approve it again.',
	)

/** The email an approval card asks about, once a person has chosen to send it. */
async function loadApproval(
	db: Database,
	workspaceId: string,
	callerId: string,
	approvalCommentId: number,
	draftId?: string,
): Promise<{ email: OutgoingEmail } | { failure: Fail }> {
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
				SEND_APPROVAL_HOWTO,
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
					SEND_APPROVAL_HOWTO,
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
				SEND_APPROVAL_HOWTO,
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
				`The card's recipient has no usable email address (${err.message}) ${SEND_APPROVAL_HOWTO}`,
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
async function loadObjectEmail(
	db: Database,
	workspaceId: string,
	objectId: string,
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
		return { failure: sendFailureFor(err) }
	}
	const approval = await findCurrentApproval(db, workspaceId, objectId, preview.content_hash)
	return {
		email,
		contentHash: preview.content_hash,
		approvalEventId: approval?.id ?? null,
		objectType: object.type,
	}
}

app.openapi(sendRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const input = c.req.valid('json')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	// 1. Is Gmail connected, and may this actor write with it? The credential is read through
	// the audited path (Keychain), then access is checked against that same row.
	let credential: Awaited<ReturnType<typeof readGmailCredential>>
	try {
		credential = await readGmailCredential(db, workspaceId, actorId)
	} catch (err) {
		if (err instanceof ScopeDeniedError) {
			const f = fail(
				403,
				'FORBIDDEN',
				'You do not have access to Gmail in this workspace. A workspace admin can grant it under Settings → Integrations.',
			)
			return c.json(f.body, f.status)
		}
		throw err
	}
	if (!credential) {
		const f = fail(
			404,
			'NOT_FOUND',
			'Gmail is not connected in this workspace.',
			'Ask a person to connect Gmail in Settings → Integrations.',
		)
		return c.json(f.body, f.status)
	}
	const integrationId = credential.id
	const access = (await resolveAgentAccess(db, workspaceId, integrationId, actorId)) ?? 'none'
	if (!canWrite(access)) {
		const f = fail(
			403,
			'FORBIDDEN',
			accessDeniedMessage({
				providerLabel: 'Gmail',
				toolName: TOOL_NAME,
				kind: 'write',
				access,
			}),
		)
		return c.json(f.body, f.status)
	}
	// 2. Work out exactly what is being sent. Nothing goes out without a person's yes, so the only
	// ways in are an approved object draft or an answered approval card.
	let email: OutgoingEmail
	const mode = 'approved_draft' as const
	// For an object draft: the approval event that unlocks it, and the hash it was approved at.
	let objectDraft: {
		id: string
		type: string
		hash: string
		approvalEventId: number | null
	} | null = null
	if (input.object_id) {
		const loaded = await loadObjectEmail(db, workspaceId, input.object_id)
		if ('failure' in loaded) return c.json(loaded.failure.body, loaded.failure.status)
		email = loaded.email
		objectDraft = {
			id: input.object_id,
			type: loaded.objectType,
			hash: loaded.contentHash,
			approvalEventId: loaded.approvalEventId,
		}
		if (!loaded.approvalEventId) {
			const f = fail(
				403,
				'FORBIDDEN',
				'Not sent. A person has to approve this email first. The draft shows an Approve button in For You and in chat. End your turn; when they have approved it, call this tool again with the same object_id.',
			)
			return c.json(f.body, f.status)
		}
	} else if (input.approval_comment_id) {
		const loaded = await loadApproval(
			db,
			workspaceId,
			actorId,
			input.approval_comment_id,
			input.draft_id,
		)
		if ('failure' in loaded) return c.json(loaded.failure.body, loaded.failure.status)
		email = loaded.email
	} else {
		// A new email passed straight to the tool: there is nothing a person has approved yet.
		const f = fail(
			403,
			'FORBIDDEN',
			'Not sent. A person has to approve every email before it is sent.',
			SEND_APPROVAL_HOWTO,
		)
		return c.json(f.body, f.status)
	}

	const hash = contentHash(email.to, email.cc ?? [], email.subject, email.body)

	// 3. One send per approval: claim it before calling Gmail, so two calls cannot both send.
	const approvalId = input.approval_comment_id ?? objectDraft?.approvalEventId ?? null
	const approval: ApprovalRef | null = approvalId
		? {
				workspaceId,
				integrationId,
				actorId,
				// For an object draft this is the id of the person's `approved` event: one approval,
				// one send, the same claim a decision card uses.
				approvalCommentId: approvalId,
				...(input.draft_id ? { draftId: input.draft_id } : {}),
			}
		: null
	if (approval && !(await claimApprovalForSend(db, approval))) {
		const state = await approvalSendState(db, approval)
		const f = fail(
			409,
			'CONFLICT',
			state === 'sent'
				? 'This approval was already used to send an email. Do not send it again.'
				: 'This approval is being used, or a send did not finish cleanly. Do not send it again; ask a person to check the Sent folder.',
		)
		return c.json(f.body, f.status)
	}
	const settle = async (outcome: 'released' | 'unknown') => {
		if (approval) await settleApprovalSend(db, approval, outcome)
	}

	// 4. Get a live token (refreshing it if needed), then send.
	let accessToken: string
	try {
		accessToken = await new TokenManager().getValidToken(db, integrationId, getProvider('gmail'))
	} catch (err) {
		await settle('released')
		if (err instanceof IntegrationAuthRevokedError) {
			const f = fail(
				409,
				'CONFLICT',
				'Gmail cannot be used right now. A person needs to reconnect Gmail in Settings → Integrations.',
			)
			return c.json(f.body, f.status)
		}
		throw err
	}

	try {
		const sent = await sendEmail(accessToken, email)
		try {
			await recordEvent(db, {
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'integration',
				entityId: integrationId,
				data: {
					provider: 'gmail',
					gmail_action: 'sent',
					mode,
					message_id: sent.messageId,
					thread_id: sent.threadId,
					content_hash: hash,
					to: email.to
						.map((r) => r.address)
						.join(', ')
						.slice(0, 300),
					recipients: email.to.length + (email.cc?.length ?? 0),
					...(approvalId ? { approval_comment_id: approvalId } : {}),
					...(input.draft_id ? { approval_draft_id: input.draft_id } : {}),
					...(objectDraft ? { object_id: objectDraft.id } : {}),
				},
			})
			// The draft's own log says it went, so its card can turn into a receipt.
			if (objectDraft) {
				await recordEvent(db, {
					workspaceId,
					actorId,
					action: DELIVERED_ACTION,
					entityType: objectDraft.type,
					entityId: objectDraft.id,
					data: {
						provider: 'gmail',
						content_hash: objectDraft.hash,
						message_id: sent.messageId,
						thread_id: sent.threadId,
						mode,
					},
				})
				// The send ends the task it carried out, so nothing still says "to do" for it.
				await recordSendOutcome(db, {
					workspaceId,
					actorId,
					target: { id: objectDraft.id, type: objectDraft.type },
					provider: 'gmail',
					skipDeliveredEvent: true,
				})
			}
		} catch (bookkeepingErr) {
			// The email is gone. Bookkeeping must not turn that into an error the caller retries.
			logger.error('Gmail email sent but the record of it failed', {
				workspaceId,
				messageId: sent.messageId,
				error: bookkeepingErr instanceof Error ? bookkeepingErr.message : String(bookkeepingErr),
			})
		}
		return c.json({ message_id: sent.messageId, thread_id: sent.threadId, mode }, 200)
	} catch (err) {
		if (!(err instanceof GmailSendError)) throw err
		logger.warn('Gmail send failed', {
			workspaceId,
			code: err.code,
			providerStatus: err.providerStatus,
		})
		// A refusal means nothing was sent, so the draft can be tried again. An unknown outcome
		// keeps the claim: sending again could deliver it twice.
		if (err.code === 'UNKNOWN_OUTCOME') await settle('unknown')
		else await settle('released')
		const f = sendFailureFor(err)
		return c.json(f.body, f.status)
	}
})

export default app
