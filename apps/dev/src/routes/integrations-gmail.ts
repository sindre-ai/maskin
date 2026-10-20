import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { IntegrationAuthRevokedError } from '../lib/integrations/errors'
import { getIntegrationCredential } from '../lib/integrations/lookup'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import {
	GmailSendError,
	type GmailSendErrorCode,
	getDraftSummary,
	sendDraft,
} from '../lib/integrations/providers/gmail/send'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'

/**
 * Send a Gmail draft from a person's click. Agents get a refusal here on purpose:
 * whether an agent may send without asking is a Keychain grant decision (Tier 3,
 * "outbound as a person"), and until that exists an agent holding this route
 * would be an unreviewed way around it. The draft is created by the agent through
 * Google's hosted Gmail MCP; a person reviews it and sends it here.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		workspaceRole?: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const paramsSchema = z.object({ draftId: z.string().min(1).max(200) })

const draftSchema = z.object({
	draft_id: z.string(),
	message_id: z.string().describe('Version of the draft. Send it back unchanged to send.'),
	thread_id: z.string().nullable(),
	to: z.string(),
	cc: z.string(),
	subject: z.string(),
	snippet: z.string(),
})

const STATUS_BY_CODE: Record<GmailSendErrorCode, 404 | 409 | 502> = {
	DRAFT_NOT_FOUND: 404,
	DRAFT_CHANGED: 409,
	// The person has to act (reconnect) before a retry can work, so not a 5xx.
	INSUFFICIENT_SCOPE: 409,
	RECONSENT_REQUIRED: 409,
	PROVIDER_ERROR: 502,
}

const API_CODE_BY_CODE = {
	DRAFT_NOT_FOUND: 'NOT_FOUND',
	DRAFT_CHANGED: 'CONFLICT',
	INSUFFICIENT_SCOPE: 'CONFLICT',
	RECONSENT_REQUIRED: 'CONFLICT',
	PROVIDER_ERROR: 'INTERNAL_ERROR',
} as const

type Failure = { status: 403 | 404 | 409 | 502; body: ReturnType<typeof createApiError> }

function failureFor(err: GmailSendError): Failure {
	return {
		status: STATUS_BY_CODE[err.code],
		body: createApiError(API_CODE_BY_CODE[err.code], err.message),
	}
}

/** Resolve the workspace's Gmail login and a fresh access token, or the reason we can't. */
async function gmailAccess(db: Database, workspaceId: string, actorId: string) {
	const integration = await getIntegrationCredential(db, workspaceId, 'gmail', actorId, {
		fallbackToAnyActor: true,
	})
	if (!integration) {
		return {
			ok: false as const,
			failure: {
				status: 404,
				body: createApiError(
					'NOT_FOUND',
					'Gmail is not connected in this workspace.',
					undefined,
					'Connect Gmail in Settings → Integrations.',
				),
			} satisfies Failure,
		}
	}
	try {
		const accessToken = await new TokenManager().getValidToken(
			db,
			integration.id,
			getProvider('gmail'),
		)
		return { ok: true as const, integration, accessToken }
	} catch (err) {
		if (err instanceof IntegrationAuthRevokedError) {
			return {
				ok: false as const,
				failure: {
					status: 409,
					body: createApiError(
						'CONFLICT',
						'Gmail access was revoked. Reconnect Gmail in Settings → Integrations.',
					),
				} satisfies Failure,
			}
		}
		throw err
	}
}

function agentRefusal(): Failure {
	return {
		status: 403,
		body: createApiError(
			'FORBIDDEN',
			'Only a person can send an email from Maskin right now.',
			undefined,
			'Create the draft and ask a person to review and send it.',
		),
	}
}

// ── GET /api/integrations/gmail/drafts/:draftId ──────────────────

const getDraftRoute = createRoute({
	method: 'get',
	path: '/drafts/{draftId}',
	tags: ['integrations'],
	summary: 'Read a Gmail draft so a person can review it before sending',
	request: { headers: workspaceIdHeader, params: paramsSchema },
	responses: {
		200: { description: 'Draft', content: { 'application/json': { schema: draftSchema } } },
		403: { description: 'Not a person', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'Reconnect needed',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: { description: 'Gmail error', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(getDraftRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { draftId } = c.req.valid('param')

	if (c.get('actorType') !== 'human') {
		const f = agentRefusal()
		return c.json(f.body, f.status)
	}

	const access = await gmailAccess(db, workspaceId, actorId)
	if (!access.ok) return c.json(access.failure.body, access.failure.status)

	try {
		const d = await getDraftSummary(access.accessToken, draftId)
		return c.json(
			{
				draft_id: d.draftId,
				message_id: d.messageId,
				thread_id: d.threadId,
				to: d.to,
				cc: d.cc,
				subject: d.subject,
				snippet: d.snippet,
			},
			200,
		)
	} catch (err) {
		if (!(err instanceof GmailSendError)) throw err
		const f = failureFor(err)
		return c.json(f.body, f.status)
	}
})

// ── POST /api/integrations/gmail/drafts/:draftId/send ────────────

const sendBodySchema = z.object({
	message_id: z
		.string()
		.min(1)
		.max(200)
		.describe('The message_id returned when the draft was read.'),
})

const sendDraftRoute = createRoute({
	method: 'post',
	path: '/drafts/{draftId}/send',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Send a Gmail draft as the connected account',
	description:
		'Irreversible. Sends only if the draft is still the version identified by message_id; otherwise 409. Never retried.',
	request: {
		headers: workspaceIdHeader,
		params: paramsSchema,
		body: { content: { 'application/json': { schema: sendBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: 'Sent',
			content: {
				'application/json': {
					schema: z.object({ message_id: z.string(), thread_id: z.string().nullable() }),
				},
			},
		},
		403: { description: 'Not a person', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'Draft changed or reconnect needed',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: { description: 'Gmail error', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(sendDraftRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { draftId } = c.req.valid('param')
	const { message_id: expectedMessageId } = c.req.valid('json')

	if (c.get('actorType') !== 'human') {
		const f = agentRefusal()
		return c.json(f.body, f.status)
	}
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	const access = await gmailAccess(db, workspaceId, actorId)
	if (!access.ok) return c.json(access.failure.body, access.failure.status)

	try {
		const sent = await sendDraft(access.accessToken, draftId, expectedMessageId)
		// The email is already gone. A failed audit insert must not turn that into an
		// error the person would answer by sending it a second time.
		try {
			await recordEvent(db, {
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'integration',
				entityId: access.integration.id,
				data: {
					provider: 'gmail',
					gmail_action: 'draft_sent',
					draft_id: draftId,
					message_id: sent.messageId,
					thread_id: sent.threadId,
				},
			})
		} catch (eventErr) {
			logger.error('Gmail draft sent but audit event failed', {
				workspaceId,
				messageId: sent.messageId,
				error: eventErr instanceof Error ? eventErr.message : String(eventErr),
			})
		}
		return c.json({ message_id: sent.messageId, thread_id: sent.threadId }, 200)
	} catch (err) {
		if (!(err instanceof GmailSendError)) throw err
		logger.warn('Gmail draft send failed', {
			workspaceId,
			code: err.code,
			providerStatus: err.providerStatus,
		})
		const f = failureFor(err)
		return c.json(f.body, f.status)
	}
})

export default app
