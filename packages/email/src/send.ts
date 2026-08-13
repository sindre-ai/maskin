import { Resend } from 'resend'
import { readResendEnv } from './env'
import { EmailSendError } from './errors'

export interface SendEmailOptions {
	to: string | string[]
	subject: string
	html: string
	text: string
	idempotencyKey?: string
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
	return { id: response.data.id }
}
