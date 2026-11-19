import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, gt, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { fileViewerUrl, frontendBaseUrl } from '../lib/file-urls'
import { canRead, canWrite, resolveAgentAccess } from '../lib/integrations/agent-access'
import { resolveCallerChat } from '../lib/integrations/chat-lift'
import {
	type Fail,
	SEND_APPROVAL_HOWTO,
	fail,
	loadApproval,
	loadObjectEmail,
} from '../lib/integrations/email-approval'
import { IntegrationAuthRevokedError, ScopeDeniedError } from '../lib/integrations/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { contentHash } from '../lib/integrations/providers/gmail/approval-hash'
import {
	GmailAttachmentError,
	fetchGmailAttachment,
	storeAttachmentFile,
} from '../lib/integrations/providers/gmail/attachment'
import {
	GmailSendError,
	type OutgoingEmail,
	parseRecipients,
	sendEmail,
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
import { DELIVERED_ACTION, hasDelivered } from '../lib/object-delivery'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { recordSendOutcome } from '../lib/send-closure'
import {
	decideSend,
	deniedMessage,
	pilotIsReason,
	recordAutoSent,
	withPilotReason,
} from '../lib/send-gate'
import { callingSessionId } from '../lib/session-flow'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'

/**
 * Send an email from the workspace's connected Gmail. Behind the `gmail_send_email`
 * MCP tool: Google's hosted Gmail tool can only create drafts.
 *
 * Who may send, in one place. Reading and drafting need Read or Read & write. Read, or no
 * access, cannot send at all. With Read & write, the agent's send setting for emails decides
 * (Settings → Autonomy and guardrails): always allow sends the email as given (`to`, `subject`,
 * `body`, or an `object_id` draft); ask first needs a person's approval of that exact email;
 * deny refuses.
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
		storageProvider?: StorageProvider
		apiKeySessionId?: string | null
		maskinSessionId?: string
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
		'Irreversible and never retried. Needs "Read & write" access. If the agent is set to always allow emails, pass to, subject and body (or object_id) and it sends. If it is set to ask first, the email must be one a person approved: an object draft they approved (object_id) or an approval card they answered (approval_comment_id).',
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

/** The workspace's Gmail login, read through Keychain so the read is gated and audited. */
const readGmailCredential = (
	db: Database,
	workspaceId: string,
	actorId: string,
	target: 'gmail:send' | 'gmail:read-attachment' = 'gmail:send',
) =>
	getIntegrationCredential(db, workspaceId, 'gmail', actorId, {
		fallbackToAnyActor: true,
		ctx: readContextFor(actorId, target),
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
	// An Allow for just this chat counts for the access level only: the approval that follows is
	// the same for everyone. Gmail is not on the chat-lift list yet, so no such grant exists today.
	const chat = await resolveCallerChat(db, c.req.header('x-maskin-session-id'), {
		workspaceId,
		actorId,
	})
	const access =
		(await resolveAgentAccess(db, workspaceId, integrationId, actorId, {
			conversationId: chat?.conversationId ?? null,
		})) ?? 'none'
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
	// 1b. The agent's send setting for emails: send as given, wait for a person, or never.
	const decision = await decideSend(db, {
		workspaceId,
		agentId: actorId,
		kind: 'email',
		sessionId: callingSessionId(c.get('apiKeySessionId'), c.get('maskinSessionId')),
	})
	if (decision === 'denied') {
		const f = fail(403, 'FORBIDDEN', deniedMessage('emails'))
		return c.json(f.body, f.status)
	}
	const mayUnapproved = decision === 'send_now'

	// 2. Work out exactly what is being sent. An agent set to ask first sends only an approved
	// object draft or an answered approval card; one set to always allow may also send an email
	// given as to, subject and body, or an object draft nobody has approved.
	let email: OutgoingEmail
	let mode: 'approved_draft' | 'direct'
	// For an object draft: the approval event that unlocks it, and the hash it was approved at.
	let objectDraft: {
		id: string
		type: string
		hash: string
		approvalEventId: number | null
	} | null = null
	if (input.object_id) {
		const loaded = await loadObjectEmail(
			db,
			c.get('storageProvider'),
			workspaceId,
			input.object_id,
			mayUnapproved,
		)
		if ('failure' in loaded) return c.json(loaded.failure.body, loaded.failure.status)
		email = loaded.email
		objectDraft = {
			id: input.object_id,
			type: loaded.objectType,
			hash: loaded.contentHash,
			approvalEventId: loaded.approvalEventId,
		}
		if (loaded.approvalEventId) {
			mode = 'approved_draft'
		} else if (mayUnapproved) {
			mode = 'direct'
		} else {
			const f = fail(
				403,
				'FORBIDDEN',
				'Not sent. This agent is set to ask first, so a person has to approve this email. The draft shows an Approve button in For You and in chat; they can edit the text there first, or just say yes in the chat (then call approve_draft_from_chat). End your turn; when they have approved it, call this tool again with the same object_id.',
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
		mode = 'approved_draft'
	} else if (mayUnapproved) {
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
	} else {
		// A new email passed straight to the tool by an agent that is set to ask first: nothing a
		// person has approved yet.
		const pilot = await pilotIsReason(db, {
			workspaceId,
			agentId: actorId,
			kind: 'email',
			sessionId: callingSessionId(c.get('apiKeySessionId'), c.get('maskinSessionId')),
		})
		const f = fail(
			403,
			'FORBIDDEN',
			pilot
				? withPilotReason('Not sent. A person has to approve this email before it is sent.', true)
				: 'Not sent. This agent is set to ask first, so a person has to approve this email before it is sent.',
			pilot
				? SEND_APPROVAL_HOWTO.replace('This agent is set to ask first for emails. ', '')
				: SEND_APPROVAL_HOWTO,
		)
		return c.json(f.body, f.status)
	}

	const hash = contentHash(email.to, email.cc ?? [], email.subject, email.body)
	if (mode === 'direct') {
		// A draft that already went is not sent again, and neither is the same text within a day:
		// an agent that retries after a timeout must not send the same email twice.
		if (objectDraft && (await hasDelivered(db, workspaceId, objectDraft.id))) {
			const f = fail(
				409,
				'CONFLICT',
				'This draft was already sent. Do not send it again. Create a new task for a new email.',
			)
			return c.json(f.body, f.status)
		}
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
		// Released on Always allow with no approval: log it on the draft.
		if (objectDraft) {
			await recordAutoSent(db, {
				workspaceId,
				agentId: actorId,
				object: { id: objectDraft.id, type: objectDraft.type },
				kind: 'email',
				contentHash: objectDraft.hash,
			})
		}
	}

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
					...(email.attachments?.length ? { attachments: email.attachments.length } : {}),
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

const SAVE_TOOL_NAME = 'gmail_save_attachment'

const saveAttachmentBodySchema = z.object({
	message_id: z.string().min(1).max(64),
	attachment_id: z.string().min(1).max(4096),
	part_id: z.string().min(1).max(64).optional(),
})

const saveAttachmentRoute = createRoute({
	method: 'post',
	path: '/save-attachment',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Save one Gmail attachment as a workspace file',
	description:
		'Reads one attachment of one message of the connected Gmail account and stores it as a workspace file. The attachment is matched by part_id first (attachment ids change between reads). Needs "Read" or "Read & write" access to Gmail. The name and type come from the message, not the caller.',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: saveAttachmentBodySchema } }, required: true },
	},
	responses: {
		201: {
			description: 'Saved',
			content: {
				'application/json': {
					schema: z.object({
						file_id: z.string().uuid(),
						name: z.string(),
						mime_type: z.string(),
						size_bytes: z.number().int(),
						url: z.string(),
					}),
				},
			},
		},
		400: { description: 'Invalid', content: { 'application/json': { schema: errorSchema } } },
		403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: { description: 'Conflict', content: { 'application/json': { schema: errorSchema } } },
		413: { description: 'Too large', content: { 'application/json': { schema: errorSchema } } },
		422: { description: 'Refused', content: { 'application/json': { schema: errorSchema } } },
		502: { description: 'Gmail error', content: { 'application/json': { schema: errorSchema } } },
	},
})

function attachmentFailureFor(
	err: GmailAttachmentError,
): Fail | { status: 413; body: Fail['body'] } {
	switch (err.code) {
		case 'INVALID_INPUT':
			return fail(400, 'BAD_REQUEST', err.message)
		case 'NOT_FOUND':
			return fail(404, 'NOT_FOUND', err.message)
		case 'TOO_LARGE':
			return { status: 413, body: createApiError('BAD_REQUEST', err.message) }
		case 'RECONSENT_REQUIRED':
		case 'INSUFFICIENT_SCOPE':
			return fail(409, 'CONFLICT', err.message)
		case 'REJECTED':
			return fail(422, 'BAD_REQUEST', err.message)
		default:
			return fail(502, 'INTERNAL_ERROR', err.message)
	}
}

app.openapi(saveAttachmentRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const input = c.req.valid('json')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	let credential: Awaited<ReturnType<typeof readGmailCredential>>
	try {
		credential = await readGmailCredential(db, workspaceId, actorId, 'gmail:read-attachment')
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
	// Reading one attachment is a read of the mailbox, so "Read" is enough.
	const access = (await resolveAgentAccess(db, workspaceId, credential.id, actorId)) ?? 'none'
	if (!canRead(access)) {
		const f = fail(
			403,
			'FORBIDDEN',
			accessDeniedMessage({
				providerLabel: 'Gmail',
				toolName: SAVE_TOOL_NAME,
				kind: 'read',
				access,
			}),
		)
		return c.json(f.body, f.status)
	}

	const storage = c.get('storageProvider')
	if (!storage) {
		const f = fail(502, 'INTERNAL_ERROR', 'File storage is not configured')
		return c.json(f.body, f.status)
	}

	let frontendUrl: string
	try {
		frontendUrl = frontendBaseUrl()
	} catch (err) {
		logger.error('Cannot mint file URL', { error: String(err) })
		const f = fail(502, 'INTERNAL_ERROR', 'File URL not configured')
		return c.json(f.body, f.status)
	}

	let accessToken: string
	try {
		accessToken = await new TokenManager().getValidToken(db, credential.id, getProvider('gmail'))
	} catch (err) {
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
		const attachment = await fetchGmailAttachment(
			accessToken,
			input.message_id,
			input.attachment_id,
			input.part_id,
		)
		const file = await storeAttachmentFile({ db, storage }, { workspaceId, actorId, ...attachment })
		try {
			await recordEvent(db, {
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'file',
				entityId: file.id,
				data: {
					id: file.id,
					name: file.name,
					mimeType: file.mimeType,
					sizeBytes: file.sizeBytes,
					source: 'gmail-attachment',
					gmail_message_id: input.message_id,
				},
				provenance: { sessionId: c.get('maskinSessionId'), entityKind: 'file' },
			})
		} catch (bookkeepingErr) {
			logger.error('Gmail attachment saved but the record of it failed', {
				workspaceId,
				fileId: file.id,
				error: bookkeepingErr instanceof Error ? bookkeepingErr.message : String(bookkeepingErr),
			})
		}
		return c.json(
			{
				file_id: file.id,
				name: file.name,
				mime_type: file.mimeType,
				size_bytes: file.sizeBytes,
				url: fileViewerUrl(frontendUrl, workspaceId, file.id),
			},
			201,
		)
	} catch (err) {
		if (!(err instanceof GmailAttachmentError)) throw err
		logger.warn('Gmail attachment save failed', { workspaceId, code: err.code })
		const f = attachmentFailureFor(err)
		return c.json(f.body, f.status)
	}
})

export default app
