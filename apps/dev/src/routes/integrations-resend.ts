import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import {
	EmailAttachmentError,
	loadEmailAttachments,
	readAttachmentIds,
} from '../lib/email-attachments'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { canWrite, resolveAgentAccess } from '../lib/integrations/agent-access'
import { IntegrationAuthRevokedError, ScopeDeniedError } from '../lib/integrations/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { contentHash } from '../lib/integrations/providers/gmail/approval-hash'
import { GmailSendError, parseRecipients } from '../lib/integrations/providers/gmail/send'
import { readAgentMailbox } from '../lib/integrations/providers/resend/mailbox'
import { ResendSendError, sendResendEmail } from '../lib/integrations/providers/resend/send'
import {
	type ResendApprovalRef,
	claimResendApproval,
	releaseResendApproval,
	resendApprovalState,
} from '../lib/integrations/providers/resend/send-claim'
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
 * Send an email from the workspace's connected Resend account. Behind the `resend_send_email`
 * tool, the way `gmail_send_email` is behind Gmail (routes/integrations-gmail.ts), with the
 * same rules:
 *
 *  - Needs "Read & write" on Resend. The agent sends straight away with `to`, `subject` and
 *    `body`, or from an email object (`object_id`, `metadata.kind = "email"`). A person's
 *    approval is optional: when the object carries one it is used and counted.
 *  - Any edit to the recipients, subject or text withdraws an approval (it is bound to the
 *    content hash), and one approval sends once.
 *  - The sender is the agent's own mailbox, read on the server (mailbox.ts), never from the
 *    call. An agent with no mailbox cannot send.
 *  - The approval's id (or, with none, the content hash) is the Resend idempotency key, so a
 *    retry cannot deliver twice.
 *
 * The Resend MCP's own send tools are held at the gateway (tool-kinds.ts), so this is the
 * one way an agent's email leaves.
 */
const app = new OpenAPIHono<{
	Variables: {
		db: Database
		actorId: string
		workspaceRole?: string
		storageProvider?: StorageProvider
	}
}>({ defaultHook: validationFailureHook })

const TOOL_NAME = 'resend_send_email'

const sendBodySchema = z
	.object({
		object_id: z.string().uuid().optional(),
		to: z.string().min(1).max(2000).optional(),
		cc: z.string().max(2000).optional(),
		subject: z.string().min(1).max(998).optional(),
		body: z.string().min(1).max(100_000).optional(),
	})
	// `from` is never accepted: the sender is the agent's mailbox. Unknown fields are refused.
	.strict()
	.refine(
		(v) =>
			v.object_id ? !v.to && !v.cc && !v.subject && !v.body : Boolean(v.to && v.subject && v.body),
		{
			message:
				'Pass object_id (to send the email an object holds) or to, subject and body (to send a new email). Not a mix.',
		},
	)

const sendRoute = createRoute({
	method: 'post',
	path: '/send',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Send an email from the agent mailbox through Resend',
	description:
		'Needs "Read & write" access to Resend and a mailbox recorded for the calling agent. Send a new email with to, subject and body, or an email object with object_id. A person\'s approval of the object is used and counted but is not required. Sends once per approval or per exact email.',
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
						email_id: z.string(),
						from: z.string(),
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
		502: { description: 'Resend error', content: { 'application/json': { schema: errorSchema } } },
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

function sendFailureFor(err: ResendSendError): Fail {
	switch (err.code) {
		case 'INVALID_EMAIL':
			return fail(400, 'BAD_REQUEST', err.message)
		case 'AUTH_REJECTED':
			return fail(409, 'CONFLICT', err.message)
		case 'REJECTED':
			return fail(422, 'BAD_REQUEST', err.message)
		case 'UNKNOWN_OUTCOME':
			return fail(502, 'INTERNAL_ERROR', err.message)
	}
}

/** The workspace's Resend key, read through Keychain so the read is gated and audited. */
const readResendCredential = (db: Database, workspaceId: string, actorId: string) =>
	getIntegrationCredential(db, workspaceId, 'resend', actorId, {
		fallbackToAnyActor: true,
		ctx: readContextFor(actorId, 'resend:send'),
	})

/**
 * The email an object holds (`metadata.kind = 'email'`), and whether a person approved exactly
 * this text. The approval is the newest `approved` event a human wrote on the object, bound to
 * the content hash, so any edit to the recipients, subject or text withdraws it.
 */
async function loadObjectEmail(
	db: Database,
	storage: StorageProvider | undefined,
	workspaceId: string,
	objectId: string,
) {
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
	try {
		const to = parseRecipients(raw('to'), 'to').map((r) => r.address)
		const cc = raw('cc') ? parseRecipients(raw('cc'), 'cc').map((r) => r.address) : []
		const approval = await findCurrentApproval(db, workspaceId, objectId, preview.content_hash)
		// With an approval a file must be unchanged since it; without one the files are read as they are.
		const attachments = await loadEmailAttachments(
			{ db, storage },
			{
				workspaceId,
				ids: readAttachmentIds(object.metadata),
				approvedAt: approval?.createdAt ?? new Date(),
			},
		)
		return {
			email: { to, cc, subject: preview.subject ?? '', body: preview.body, attachments },
			contentHash: preview.content_hash,
			approvalEventId: approval?.id ?? null,
			objectType: object.type,
		}
	} catch (err) {
		// Gmail's parser is the one address reader both send routes share.
		if (err instanceof GmailSendError || err instanceof EmailAttachmentError) {
			return { failure: fail(400, 'BAD_REQUEST', err.message) }
		}
		throw err
	}
}

app.openapi(sendRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const input = c.req.valid('json')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	// 1. Is Resend connected, and may this actor write with it?
	let credential: Awaited<ReturnType<typeof readResendCredential>>
	try {
		credential = await readResendCredential(db, workspaceId, actorId)
	} catch (err) {
		if (err instanceof ScopeDeniedError) {
			const f = fail(
				403,
				'FORBIDDEN',
				'You do not have access to Resend in this workspace. A workspace admin can grant it under Settings → Integrations.',
			)
			return c.json(f.body, f.status)
		}
		throw err
	}
	if (!credential) {
		const f = fail(
			404,
			'NOT_FOUND',
			'Resend is not connected in this workspace.',
			'Ask a person to connect Resend in Settings → Integrations.',
		)
		return c.json(f.body, f.status)
	}
	const integrationId = credential.id
	const access = (await resolveAgentAccess(db, workspaceId, integrationId, actorId)) ?? 'none'
	if (!canWrite(access)) {
		const f = fail(
			403,
			'FORBIDDEN',
			accessDeniedMessage({ providerLabel: 'Resend', toolName: TOOL_NAME, kind: 'write', access }),
		)
		return c.json(f.body, f.status)
	}

	// 2. The sender is this agent's mailbox, recorded on the server. Nothing in the call or the
	// draft can name it, so an agent cannot send as someone else, and one with no mailbox
	// cannot send at all.
	const from = await readAgentMailbox(db, actorId)
	if (!from) {
		const f = fail(
			403,
			'FORBIDDEN',
			'Not sent. No mailbox is recorded for you, so there is no address to send from.',
			'Ask a human workspace admin to set your mailbox (the "mailbox" field on your agent), then call this again.',
		)
		return c.json(f.body, f.status)
	}

	// 3. What goes out: an email object (with a person's approval if it has one) or a new email.
	const objectId = input.object_id ?? null
	let email: {
		to: string[]
		cc: string[]
		subject: string
		body: string
		attachments: Awaited<ReturnType<typeof loadEmailAttachments>>
	}
	let hash: string
	let objectType: string | null = null
	let approvalEventId: number | null = null
	if (objectId) {
		const loaded = await loadObjectEmail(db, c.get('storageProvider'), workspaceId, objectId)
		if (loaded.failure) return c.json(loaded.failure.body, loaded.failure.status)
		email = loaded.email
		hash = loaded.contentHash
		objectType = loaded.objectType
		approvalEventId = loaded.approvalEventId
	} else {
		try {
			const to = parseRecipients(input.to ?? '', 'to')
			const cc = input.cc ? parseRecipients(input.cc, 'cc') : []
			hash = contentHash(to, cc, input.subject ?? '', input.body ?? '')
			email = {
				to: to.map((r) => r.address),
				cc: cc.map((r) => r.address),
				subject: input.subject ?? '',
				body: input.body ?? '',
				attachments: [],
			}
		} catch (err) {
			if (err instanceof GmailSendError) {
				const f = fail(400, 'BAD_REQUEST', err.message)
				return c.json(f.body, f.status)
			}
			throw err
		}
	}
	const mode = approvalEventId ? ('approved_draft' as const) : ('direct' as const)

	// 4. One send per approval: claim it before calling Resend, so two calls cannot both send.
	// With no approval the idempotency key below (the exact email) stops a repeat within Resend's window.
	const approval: ResendApprovalRef | null = approvalEventId
		? { workspaceId, integrationId, actorId, approvalEventId }
		: null
	if (approval && !(await claimResendApproval(db, approval))) {
		const state = await resendApprovalState(db, approval)
		const f = fail(
			409,
			'CONFLICT',
			state === 'sent'
				? 'This approval was already used to send an email. Do not send it again.'
				: 'This approval is being used by another call right now. Do not send it again; wait and check the draft.',
		)
		return c.json(f.body, f.status)
	}
	const release = async () => {
		if (approval) await releaseResendApproval(db, approval)
	}

	// 5. A live key, then send. The idempotency key is the approval (or the exact email), so a
	// retry of an unclear failure cannot deliver twice.
	let apiKey: string
	try {
		apiKey = await new TokenManager().getValidToken(db, integrationId, getProvider('resend'))
	} catch (err) {
		await release()
		if (err instanceof IntegrationAuthRevokedError) {
			const f = fail(
				409,
				'CONFLICT',
				'Resend cannot be used right now. A person needs to reconnect Resend in Settings → Integrations.',
			)
			return c.json(f.body, f.status)
		}
		throw err
	}

	try {
		const sent = await sendResendEmail(
			apiKey,
			{ from, ...email },
			approvalEventId
				? `maskin-email-${objectId}-${approvalEventId}`
				: `maskin-email-direct-${actorId}-${hash}`,
		)
		try {
			await recordEvent(db, {
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'integration',
				entityId: integrationId,
				data: {
					provider: 'resend',
					resend_action: 'sent',
					mode,
					email_id: sent.emailId,
					from,
					content_hash: hash,
					to: email.to.join(', ').slice(0, 300),
					recipients: email.to.length + email.cc.length,
					...(email.attachments.length ? { attachments: email.attachments.length } : {}),
					...(approvalEventId ? { approval_event_id: approvalEventId } : {}),
					...(objectId ? { object_id: objectId } : {}),
				},
			})
			if (objectId && objectType) {
				// The draft's own log says it went, so its card can turn into a receipt.
				await recordEvent(db, {
					workspaceId,
					actorId,
					action: DELIVERED_ACTION,
					entityType: objectType,
					entityId: objectId,
					data: { provider: 'resend', content_hash: hash, message_id: sent.emailId, from },
				})
				// The send ends the task it carried out, so nothing still says "to do" for it.
				await recordSendOutcome(db, {
					workspaceId,
					actorId,
					target: { id: objectId, type: objectType },
					provider: 'resend',
					skipDeliveredEvent: true,
				})
			}
		} catch (bookkeepingErr) {
			// The email is gone. Bookkeeping must not turn that into an error the caller retries.
			logger.error('Resend email sent but the record of it failed', {
				workspaceId,
				emailId: sent.emailId,
				error: bookkeepingErr instanceof Error ? bookkeepingErr.message : String(bookkeepingErr),
			})
		}
		return c.json({ email_id: sent.emailId, from, mode }, 200)
	} catch (err) {
		if (!(err instanceof ResendSendError)) {
			await release()
			throw err
		}
		logger.warn('Resend send failed', {
			workspaceId,
			code: err.code,
			providerStatus: err.providerStatus,
		})
		// Whatever failed, nothing is confirmed sent and a retry carries the same idempotency
		// key, so the approval goes back in the pool.
		await release()
		const f = sendFailureFor(err)
		return c.json(f.body, f.status)
	}
})

export default app
