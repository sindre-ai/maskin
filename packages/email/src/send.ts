import { capturePosthogEvent } from '@maskin/shared'
import { Resend } from 'resend'
import { readResendEnv } from './env'
import { EmailSendError } from './errors'

export interface SendEmailAnalytics {
	// Workspace whose behaviour is being measured — used as the PostHog
	// distinct_id so the ship metric ("share of active workspaces with ≥1
	// agent-sent email") can query by unique workspace.
	workspaceId: string
	// Template name for Layer 1 (e.g. 'account_verification',
	// 'password_reset') or the literal string 'agent' for Layer 2 sends.
	emailType: string
	// The agent that initiated the send for Layer 2, or null for a
	// system-originated Layer 1 send.
	agentId?: string | null
}

export interface SendEmailOptions {
	to: string | string[]
	subject: string
	html: string
	text: string
	idempotencyKey?: string
	// Required so no caller can silently bypass the `email_sent` PostHog
	// event that the ship metric depends on.
	analytics: SendEmailAnalytics
}

export interface SendEmailResult {
	id: string
}

let cachedClient: Resend | null = null
let cachedApiKey: string | null = null

function getClient(apiKey: string): Resend {
	if (!cachedClient || cachedApiKey !== apiKey) {
		cachedClient = new Resend(apiKey)
		cachedApiKey = apiKey
	}
	return cachedClient
}

export function resetResendClientForTesting(): void {
	cachedClient = null
	cachedApiKey = null
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
	const { apiKey, from } = readResendEnv()
	const client = getClient(apiKey)

	let response: Awaited<ReturnType<typeof client.emails.send>>
	try {
		response = await client.emails.send(
			{
				from,
				to: opts.to,
				subject: opts.subject,
				html: opts.html,
				text: opts.text,
			},
			opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
		)
	} catch (err) {
		throw new EmailSendError(
			'transport_error',
			err instanceof Error ? err.message : 'Unknown transport error',
			err,
		)
	}

	if (response.error) {
		throw new EmailSendError(
			response.error.name ?? 'provider_error',
			response.error.message ?? 'Resend returned an error',
			response.error,
		)
	}
	if (!response.data?.id) {
		throw new EmailSendError('provider_empty_response', 'Resend returned no message id', response)
	}

	const providerMessageId = response.data.id

	// Fire-and-forget: the caller's happy path is complete regardless of
	// whether analytics succeed. capturePosthogEvent never throws.
	void capturePosthogEvent('email_sent', opts.analytics.workspaceId, {
		workspace_id: opts.analytics.workspaceId,
		email_type: opts.analytics.emailType,
		agent_id: opts.analytics.agentId ?? null,
		idempotency_key: opts.idempotencyKey ?? null,
		provider_message_id: providerMessageId,
	})

	return { id: providerMessageId }
}
