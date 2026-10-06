import { logger } from '../../../logger'
import type { ResendEmailReceived } from './schemas'

export const MAX_ATTEMPTS = 3
export const PER_ATTEMPT_TIMEOUT_MS = 3000
export const BACKOFF_MS = [0, 250, 750]

/**
 * Thrown for a 4xx (non-429) response from Resend's Received Emails API — the
 * email is gone from Resend or the credential is bad; retrying will not help.
 * The route releases the claim and returns 500 so Resend retries the whole
 * webhook (which will hit the same terminal failure and log it again — noisy
 * on purpose so we notice a persistent issue).
 */
export class BodyFetchTerminalError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message)
		this.name = 'BodyFetchTerminalError'
	}
}

type ResendReceivedEmailBody = {
	html?: string
	text?: string
	subject?: string
	from?: string
	to?: string[]
	cc?: string[]
	bcc?: string[]
	headers?: Record<string, string>
}

/**
 * Synchronously fetches the full email body from Resend's Received Emails API
 * and merges it into the metadata-only webhook payload. Must run BEFORE
 * `commitWebhookDelivery` — the trigger fires off `events.data`, and if the
 * body isn't in `events.data` at commit time the agent wakes on an empty
 * email.
 *
 * Retry budget (see spec §5.2): 3 attempts, 3s per-attempt timeout, backoff
 * [0, 250ms, 750ms] — worst case ~4s. 429 and 5xx retry; 4xx (non-429) throws
 * `BodyFetchTerminalError` immediately.
 */
export async function fetchResendBodyWithRetry(
	apiKey: string,
	emailId: string,
	metadata: ResendEmailReceived,
): Promise<ResendEmailReceived> {
	let lastError: unknown
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const backoff = BACKOFF_MS[attempt] ?? 0
		if (backoff > 0) await sleep(backoff)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS)
		const startedAt = Date.now()
		try {
			const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: controller.signal,
			})
			clearTimeout(timer)
			if (res.status === 429 || res.status >= 500) {
				logger.warn('resend.body_fetch.retry', {
					email_id: emailId,
					attempt,
					status_or_err: res.status,
				})
				lastError = new Error(`resend body-fetch returned ${res.status}`)
				continue
			}
			if (!res.ok) {
				throw new BodyFetchTerminalError(`resend body-fetch returned ${res.status}`, res.status)
			}
			const body = (await res.json()) as ResendReceivedEmailBody
			logger.info('resend.body_fetch.ok', {
				email_id: emailId,
				attempt,
				latency_ms: Date.now() - startedAt,
			})
			return mergeBody(metadata, body)
		} catch (err) {
			clearTimeout(timer)
			if (err instanceof BodyFetchTerminalError) throw err
			lastError = err
			logger.warn('resend.body_fetch.retry', {
				email_id: emailId,
				attempt,
				status_or_err: err instanceof Error ? err.message : String(err),
			})
		}
	}
	throw lastError instanceof Error ? lastError : new Error('resend body-fetch exhausted retries')
}

function mergeBody(
	metadata: ResendEmailReceived,
	body: ResendReceivedEmailBody,
): ResendEmailReceived {
	return {
		...metadata,
		data: {
			...metadata.data,
			html: body.html ?? metadata.data.html,
			text: body.text ?? metadata.data.text,
			subject: body.subject ?? metadata.data.subject,
			from: body.from ?? metadata.data.from,
			to: body.to ?? metadata.data.to,
			cc: body.cc ?? metadata.data.cc,
			bcc: body.bcc ?? metadata.data.bcc,
			headers: body.headers ?? metadata.data.headers,
		},
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
