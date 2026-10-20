import { createHash } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, objects } from '@maskin/db/schema'
import { commentDecisionSchema, readChanges } from '@maskin/shared'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { canActWithoutAsking, canWrite, resolveAgentAccess } from '../lib/integrations/agent-access'
import { IntegrationAuthRevokedError, ScopeDeniedError } from '../lib/integrations/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
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
import { findBlockedRecipients } from '../lib/integrations/providers/gmail/send-guard'
import { readContextFor } from '../lib/integrations/read-context'
import { getProvider } from '../lib/integrations/registry'
import { accessDeniedMessage } from '../lib/integrations/tool-gate'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'

/**
 * Send an email from the workspace's connected Gmail. Behind the `gmail_send_email`
 * MCP tool: Google's hosted Gmail tool can only create drafts.
 *
 * Who may send, in one place. Gmail access has three modes per agent, like a coding agent's
 * permission modes (Settings → Integrations):
 *  - Read & write ("always allow"): sends on its own, to anyone except a protected recipient.
 *  - Ask first: may draft, but every email needs a person to approve it first.
 *  - Read, or no access: cannot send at all.
 *  - A recipient a person marked protected (or who opted out) needs approval whatever the mode.
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
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000

const sendBodySchema = z
	.object({
		to: z.string().min(1).max(2000).optional(),
		cc: z.string().max(2000).optional(),
		subject: z.string().min(1).max(998).optional(),
		body: z.string().min(1).max(100_000).optional(),
		approval_comment_id: z.number().int().positive().optional(),
	})
	.refine(
		(v) =>
			v.approval_comment_id
				? !v.to && !v.cc && !v.subject && !v.body
				: Boolean(v.to && v.subject && v.body),
		{
			message:
				'Pass either approval_comment_id (to send an email a person approved) or to, subject and body (to send a new email), not both.',
		},
	)

const sendRoute = createRoute({
	method: 'post',
	path: '/send',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Send an email from the connected Gmail account',
	description:
		'Irreversible and never retried. "Read & write" access sends directly; "Ask first" access, and any protected recipient, needs an approval card a person answered (approval_comment_id).',
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
						mode: z.enum(['approved_draft', 'direct']),
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

const contentHash = (to: Recipient[], cc: Recipient[], subject: string, body: string) =>
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
	'Post a decision comment (create_comment with `decision` and the person in `mentions`) whose `draft` holds the email: `to` with the real address ("Mette Holm <mette@northwind.dk>"), and the text starting with a line "Subject: ..." then the body. Mark the option that sends as destructive. End your turn; when the person has chosen it, call gmail_send_email with approval_comment_id set to the id of your comment.'

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

/** The email an approval card asks about, once a person has chosen to send it. */
async function loadApproval(
	db: Database,
	workspaceId: string,
	callerId: string,
	approvalCommentId: number,
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
	if (!decision.success || !decision.data.draft) {
		return {
			failure: fail(
				409,
				'CONFLICT',
				'That comment is not an approval card with a draft attached.',
				SEND_APPROVAL_HOWTO,
			),
		}
	}
	const { draft, options } = decision.data
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
	const [answer] = await db
		.select({
			id: events.id,
			content: sql<string | null>`${events.data}->>'content'`,
			createdAt: events.createdAt,
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
	if (!answer) {
		return {
			failure: fail(
				409,
				'CONFLICT',
				'No person has answered the approval card yet. Do not send.',
				'End your turn and wait for them to choose.',
			),
		}
	}
	if (answer.content?.trim() !== sendLabel.trim()) {
		return {
			failure: fail(
				409,
				'CONFLICT',
				`The person chose "${answer.content?.trim() ?? ''}", not "${sendLabel}". Do not send.`,
			),
		}
	}

	// The text is what the card shows: the draft object's current text, else the stored body.
	let text: string | undefined
	if (draft.object_id) {
		const [object] = await db
			.select({ content: objects.content, updatedAt: objects.updatedAt })
			.from(objects)
			.where(and(eq(objects.id, draft.object_id), eq(objects.workspaceId, workspaceId)))
			.limit(1)
		if (object?.content?.trim()) {
			if (await textChangedAfter(db, workspaceId, draft.object_id, answer, object.updatedAt)) {
				return {
					failure: fail(
						409,
						'CONFLICT',
						'The draft was changed after the person approved it, so they did not approve this text. Do not send it.',
						'Post a new approval card with the current text.',
					),
				}
			}
			text = object.content
		}
	}
	text ??= draft.body
	if (!text?.trim()) {
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
	return { email: { to, subject: parts.subject, body: parts.body } }
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
	// "Ask first" may draft and send what a person approved, but not send on its own.
	if (!input.approval_comment_id && !canActWithoutAsking(access)) {
		const f = fail(
			403,
			'FORBIDDEN',
			'Not sent. Your access to Gmail is "Ask first": a person has to approve each email before it is sent.',
			SEND_APPROVAL_HOWTO,
		)
		return c.json(f.body, f.status)
	}

	// 2. Work out exactly what is being sent, and whether it may go without a person's yes.
	let email: OutgoingEmail
	let mode: 'approved_draft' | 'direct'
	if (input.approval_comment_id) {
		const loaded = await loadApproval(db, workspaceId, actorId, input.approval_comment_id)
		if ('failure' in loaded) return c.json(loaded.failure.body, loaded.failure.status)
		email = loaded.email
		mode = 'approved_draft'
	} else {
		try {
			email = {
				to: parseRecipients(input.to as string, 'to'),
				cc: input.cc ? parseRecipients(input.cc, 'cc') : [],
				subject: input.subject as string,
				body: input.body as string,
			}
		} catch (err) {
			if (!(err instanceof GmailSendError)) throw err
			const f = sendFailureFor(err)
			return c.json(f.body, f.status)
		}
		mode = 'direct'

		const blocked = await findBlockedRecipients(
			db,
			workspaceId,
			[...email.to, ...(email.cc ?? [])].map((r) => r.address),
		)
		if (blocked.length > 0) {
			const who = blocked.map((b) => `${b.address} ${b.reason}`).join('; ')
			const f = fail(
				403,
				'FORBIDDEN',
				`Not sent. ${who}, so a person has to approve this email first.`,
				SEND_APPROVAL_HOWTO,
			)
			return c.json(f.body, f.status)
		}
	}

	const hash = contentHash(email.to, email.cc ?? [], email.subject, email.body)
	if (mode === 'direct') {
		// An agent that retries after a timeout must not send the same email twice.
		const since = new Date(Date.now() - DUPLICATE_WINDOW_MS)
		const [dup] = await db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityId, integrationId),
					gt(events.createdAt, since),
					sql`${events.data}->>'content_hash' = ${hash}`,
				),
			)
			.limit(1)
		if (dup) {
			const f = fail(
				409,
				'CONFLICT',
				'This exact email was already sent in the last 24 hours. Do not send it again.',
			)
			return c.json(f.body, f.status)
		}
	}

	// 3. One send per approval: claim it before calling Gmail, so two calls cannot both send.
	const approval: ApprovalRef | null = input.approval_comment_id
		? { workspaceId, integrationId, actorId, approvalCommentId: input.approval_comment_id }
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
					...(input.approval_comment_id ? { approval_comment_id: input.approval_comment_id } : {}),
				},
			})
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
