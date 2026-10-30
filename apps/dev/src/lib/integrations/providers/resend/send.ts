/**
 * Sending one email through Resend's REST API. Resend's hosted MCP can send too, but only
 * this path sends: the gateway holds the MCP's send tools back (see tool-kinds.ts), so a
 * person has approved every email that comes through here.
 *
 * Unlike Gmail, Resend dedupes on an `Idempotency-Key` header for 24 hours, so a retry
 * with the same key cannot deliver twice. That is what lets an unclear failure be retried.
 */

const RESEND_API_BASE = 'https://api.resend.com'

/** Resend caps one request at 50 recipients; one email to a handful is all a draft needs. */
export const MAX_RECIPIENTS = 20
const MAX_BODY_LENGTH = 100_000

export type ResendSendErrorCode =
	| 'INVALID_EMAIL'
	| 'AUTH_REJECTED'
	/** Resend refused it (a bad address, an unverified sender domain). Nothing was sent. */
	| 'REJECTED'
	/** Resend may or may not have sent it. Retrying with the same idempotency key is safe. */
	| 'UNKNOWN_OUTCOME'

export class ResendSendError extends Error {
	constructor(
		readonly code: ResendSendErrorCode,
		message: string,
		readonly providerStatus = 0,
	) {
		super(message)
		this.name = 'ResendSendError'
	}
}

export interface ResendEmail {
	/** The sender's bare address: read from the agent's mailbox on the server, never from the call. */
	from: string
	to: string[]
	cc?: string[]
	subject: string
	body: string
}

async function describeFailure(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { message?: string }
		return body.message ?? res.statusText
	} catch {
		return res.statusText
	}
}

/**
 * Status handling is split the way Gmail's is: a 4xx means Resend refused it (nothing was
 * sent); anything else, a network failure included, might have been sent. Both are safe to
 * try again under the same `idempotencyKey`, which is why the route releases the approval
 * in both cases.
 */
export async function sendResendEmail(
	apiKey: string,
	email: ResendEmail,
	idempotencyKey: string,
): Promise<{ emailId: string }> {
	if (email.to.length + (email.cc?.length ?? 0) > MAX_RECIPIENTS) {
		throw new ResendSendError('INVALID_EMAIL', `At most ${MAX_RECIPIENTS} recipients are allowed.`)
	}
	if (email.body.length > MAX_BODY_LENGTH) {
		throw new ResendSendError('INVALID_EMAIL', 'The email body is too long.')
	}

	let res: Response
	try {
		res = await fetch(`${RESEND_API_BASE}/emails`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'Idempotency-Key': idempotencyKey,
			},
			// Plain text only, no attachments, no bcc, no scheduled time, no reply-to: the
			// draft holds recipients, subject and text, and that is exactly what was approved.
			body: JSON.stringify({
				from: email.from,
				to: email.to,
				...(email.cc?.length ? { cc: email.cc } : {}),
				subject: email.subject,
				text: email.body,
			}),
		})
	} catch {
		throw new ResendSendError(
			'UNKNOWN_OUTCOME',
			'The connection to Resend failed while sending. The email may or may not have gone out. Calling this tool again with the same object_id is safe: Resend ignores a repeat of the same approval.',
		)
	}

	if (!res.ok) {
		const detail = await describeFailure(res)
		if (res.status === 401 || res.status === 403) {
			throw new ResendSendError(
				'AUTH_REJECTED',
				`Resend refused the saved key or the sender: ${detail}. A person needs to check the Resend connection and the sender domain in Settings → Integrations.`,
				res.status,
			)
		}
		if (res.status === 409 || res.status === 429 || res.status >= 500) {
			// 409: another request with this key is still running. 429/5xx: nothing confirmed.
			throw new ResendSendError(
				'UNKNOWN_OUTCOME',
				`Resend returned an error (${res.status}) while sending: ${detail}. The email may or may not have gone out. Calling this tool again with the same object_id is safe: Resend ignores a repeat of the same approval.`,
				res.status,
			)
		}
		throw new ResendSendError('REJECTED', `Resend refused the email: ${detail}`, res.status)
	}

	const sent = (await res.json().catch(() => ({}))) as { id?: string }
	if (!sent.id) {
		throw new ResendSendError(
			'UNKNOWN_OUTCOME',
			'Resend did not confirm the send. Calling this tool again with the same object_id is safe: Resend ignores a repeat of the same approval.',
			res.status,
		)
	}
	return { emailId: sent.id }
}
