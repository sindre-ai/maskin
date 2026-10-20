import { createHash } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, messages, objects } from '@maskin/db/schema'
import { readDraftTaskState } from '@maskin/shared'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { canWrite, resolveAgentAccess } from '../lib/integrations/agent-access'
import { IntegrationAuthRevokedError, ScopeDeniedError } from '../lib/integrations/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import {
	GmailSendError,
	type OutgoingEmail,
	type Recipient,
	parseRecipients,
	sendEmail,
} from '../lib/integrations/providers/gmail/send'
import {
	type DraftSendOutcome,
	claimDraftForSend,
	settleDraftSend,
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
 * Who may send, in one place:
 *  - Write access to Gmail (Settings → Integrations, per agent) is the permission. An agent
 *    with it sends on its own; one without it is refused with the usual access message.
 *  - A recipient a person marked protected (or who opted out) is the exception: that send
 *    needs a person's approval on a draft card first, then goes through as `draft_object_id`.
 *  - An approved draft sends exactly the text and subject saved on the card, once.
 *    The approval has to have been made by a person, read from the audit log, because the
 *    approve route itself accepts any workspace writer.
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
		draft_object_id: z.string().uuid().optional(),
	})
	.refine(
		(v) =>
			v.draft_object_id
				? !v.to && !v.cc && !v.subject && !v.body
				: Boolean(v.to && v.subject && v.body),
		{
			message:
				'Pass either draft_object_id (to send an approved draft) or to, subject and body (to send a new email), not both.',
		},
	)

const sendRoute = createRoute({
	method: 'post',
	path: '/send',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Send an email from the connected Gmail account',
	description:
		'Irreversible and never retried. Needs write access to Gmail. A protected recipient needs an approved draft card (draft_object_id).',
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

/** The email a draft card holds: the saved subject and text, and the address from the card. */
async function loadApprovedDraft(
	db: Database,
	workspaceId: string,
	draftObjectId: string,
): Promise<{ email: OutgoingEmail } | { failure: Fail }> {
	const [object] = await db
		.select()
		.from(objects)
		.where(and(eq(objects.id, draftObjectId), eq(objects.workspaceId, workspaceId)))
		.limit(1)
	if (!object) return { failure: fail(404, 'NOT_FOUND', 'That draft does not exist.') }

	const state = readDraftTaskState(object.metadata as Record<string, unknown> | null)
	if (!state) {
		return { failure: fail(409, 'CONFLICT', 'That object is not a draft card.') }
	}
	if (state.state !== 'approved') {
		return {
			failure: fail(
				409,
				'CONFLICT',
				'A person has not approved this draft yet, or took the approval back. Do not send it.',
				'Wait for the person to approve the card in the chat and mention you.',
			),
		}
	}
	const sendState = (object.metadata as Record<string, unknown> | null)?.draft_send_state
	if (sendState) {
		return {
			failure: fail(
				409,
				'CONFLICT',
				sendState === 'sent'
					? 'This draft was already sent. Do not send it again.'
					: 'This draft is being sent, or a send did not finish cleanly. Do not send it again; ask a person to check the Sent folder.',
			),
		}
	}

	// The approve route accepts any workspace writer, agents included, so "approved"
	// alone proves nothing. The person's yes is the latest approve event on the draft.
	const [approval] = await db
		.select({ actorType: actors.type })
		.from(events)
		.innerJoin(actors, eq(actors.id, events.actorId))
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, draftObjectId),
				sql`${events.data}->>'draft_action' = 'approve'`,
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	if (approval?.actorType !== 'human') {
		return {
			failure: fail(
				409,
				'CONFLICT',
				'This draft was not approved by a person. Do not send it.',
				'Ask a person to approve the card.',
			),
		}
	}

	// The recipient lives on the card's message, not on the task.
	const [card] = await db
		.select({ metadata: messages.metadata })
		.from(messages)
		.where(sql`${messages.metadata}->'draft'->>'object_id' = ${draftObjectId}`)
		.orderBy(messages.id)
		.limit(1)
	const draft = (card?.metadata as { draft?: { kind?: string; to?: string } } | null)?.draft
	if (draft?.kind !== 'email') {
		return { failure: fail(409, 'CONFLICT', 'That draft card is not an email.') }
	}
	if (!draft.to) {
		return { failure: fail(400, 'BAD_REQUEST', 'The draft card has no recipient.') }
	}
	if (!state.subject?.trim()) {
		return { failure: fail(400, 'BAD_REQUEST', 'The draft card has no subject.') }
	}
	let to: Recipient[]
	try {
		to = parseRecipients(draft.to)
	} catch (err) {
		if (!(err instanceof GmailSendError)) throw err
		return {
			failure: fail(
				400,
				'BAD_REQUEST',
				`The card's recipient has no usable email address (${err.message}) Post a new draft with the address in "to", for example "Mette Holm <mette@northwind.dk>".`,
			),
		}
	}
	return { email: { to, subject: state.subject, body: object.content ?? '' } }
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

	// 2. Work out exactly what is being sent, and whether it may go without a person's yes.
	let email: OutgoingEmail
	let mode: 'approved_draft' | 'direct'
	if (input.draft_object_id) {
		const loaded = await loadApprovedDraft(db, workspaceId, input.draft_object_id)
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
				'Show it with post_draft (kind "email", with the address in "to"), end your turn, and when the person approves, call gmail_send_email with draft_object_id.',
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

	// 3. One send per approved draft: claim it before calling Gmail, so two calls cannot both send.
	if (input.draft_object_id && !(await claimDraftForSend(db, input.draft_object_id))) {
		const f = fail(
			409,
			'CONFLICT',
			'This draft was just sent, or the approval was taken back. Do not send it.',
		)
		return c.json(f.body, f.status)
	}
	const settle = async (outcome: DraftSendOutcome) => {
		if (input.draft_object_id) await settleDraftSend(db, input.draft_object_id, outcome)
	}

	// 4. Get a live token (refreshing it if needed), then send.
	let accessToken: string
	try {
		accessToken = await new TokenManager().getValidToken(db, integrationId, getProvider('gmail'))
	} catch (err) {
		await settle({ state: 'released' })
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
		const sentAt = new Date().toISOString()
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
					...(input.draft_object_id ? { draft_object_id: input.draft_object_id } : {}),
				},
			})
			await settle({ state: 'sent', sentAt, messageId: sent.messageId })
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
		if (err.code === 'UNKNOWN_OUTCOME') await settle({ state: 'unknown' })
		else await settle({ state: 'released' })
		const f = sendFailureFor(err)
		return c.json(f.body, f.status)
	}
})

export default app
