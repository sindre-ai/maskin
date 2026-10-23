/**
 * Sending an email through Gmail. Google's hosted Gmail MCP only creates drafts, so
 * this is the one place Maskin itself calls `messages.send`. `gmail.compose` (already
 * in the connect scopes) covers it, so no existing install needs to reconnect.
 *
 * Sending cannot be undone and Gmail has no idempotency key for it, so nothing here
 * retries: an ambiguous failure is reported, never repeated.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export const MAX_RECIPIENTS = 20
const MAX_SUBJECT_LENGTH = 998
const MAX_BODY_LENGTH = 100_000

export type GmailSendErrorCode =
	| 'INVALID_EMAIL'
	| 'INSUFFICIENT_SCOPE'
	| 'RECONSENT_REQUIRED'
	| 'REJECTED'
	/** Gmail may or may not have sent it. Do not send again without looking in the Sent folder. */
	| 'UNKNOWN_OUTCOME'

export class GmailSendError extends Error {
	constructor(
		readonly code: GmailSendErrorCode,
		message: string,
		readonly providerStatus = 0,
	) {
		super(message)
		this.name = 'GmailSendError'
	}
}

export interface Recipient {
	/** Lowercased bare address, the form used for matching and for the envelope. */
	address: string
	/** Display name, when one was given. Never contains control characters or quotes. */
	name: string | null
}

// Deliberately narrower than RFC 5322: a letter-or-digit domain with at least one dot,
// and a local part without quotes, spaces or angle brackets. An address this rejects can
// be sent from Gmail by hand; one this accepts cannot smuggle a header.
const ADDRESS_RE =
	/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

/** True for any control character, line breaks included: the way a header gets smuggled. */
function hasControlChars(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

function isPlainAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x20 || code > 0x7e) return false
	}
	return true
}

/**
 * Parses "ada@example.com" or "Ada Lovelace <ada@example.com>", comma separated.
 * Throws INVALID_EMAIL on anything it cannot read exactly, rather than guessing.
 */
export function parseRecipients(input: string, label = 'to'): Recipient[] {
	if (hasControlChars(input)) {
		throw new GmailSendError('INVALID_EMAIL', `The "${label}" field contains a line break.`)
	}
	const parts = input
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean)
	if (parts.length === 0) {
		throw new GmailSendError('INVALID_EMAIL', `The "${label}" field has no email address.`)
	}
	return parts.map((part) => {
		const angle = part.match(/^(.*)<([^<>]+)>$/)
		const address = (angle ? (angle[2] ?? '') : part).trim()
		const name = angle ? (angle[1] ?? '').trim().replace(/^"|"$/g, '').trim() : ''
		if (!ADDRESS_RE.test(address) || address.length > 254) {
			throw new GmailSendError(
				'INVALID_EMAIL',
				`"${part}" in the "${label}" field is not an email address. Use an address like name@example.com.`,
			)
		}
		if (name.includes('"') || name.includes('<') || name.includes('>')) {
			throw new GmailSendError('INVALID_EMAIL', `The name "${name}" cannot be used in an address.`)
		}
		return { address: address.toLowerCase(), name: name || null }
	})
}

/** RFC 2047: non-ASCII header text goes out as UTF-8 base64 encoded words. */
function encodeHeaderText(text: string): string {
	if (isPlainAscii(text)) return text
	return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function formatRecipient(r: Recipient): string {
	if (!r.name) return r.address
	return `${encodeHeaderText(r.name).replace(/[\\"]/g, '')} <${r.address}>`
}

// An email draft starts with its subject on a line of its own, so the person who approves
// the card reads the subject too: a decision card has no subject field of its own.
const SUBJECT_LINE = /^subject:[ \t]*(\S.*?)[ \t]*(?:\r?\n|$)/i

/** "Subject: Hello\n\nBody..." → the subject and the body. Null when either is missing. */
export function splitSubject(text: string): { subject: string; body: string } | null {
	const trimmed = text.trimStart()
	const match = SUBJECT_LINE.exec(trimmed)
	if (!match?.[1]) return null
	const body = trimmed.slice(match[0].length).replace(/^\r?\n/, '')
	return body.trim() ? { subject: match[1], body } : null
}

export interface OutgoingEmail {
	to: Recipient[]
	cc?: Recipient[]
	subject: string
	body: string
}

/** The RFC 5322 message, ready to be base64url encoded for `messages.send`. */
export function buildMimeMessage(email: OutgoingEmail): string {
	if (hasControlChars(email.subject)) {
		throw new GmailSendError('INVALID_EMAIL', 'The subject contains a line break.')
	}
	if (email.subject.length > MAX_SUBJECT_LENGTH) {
		throw new GmailSendError('INVALID_EMAIL', 'The subject is too long.')
	}
	if (email.body.length > MAX_BODY_LENGTH) {
		throw new GmailSendError('INVALID_EMAIL', 'The email body is too long.')
	}
	const all = [...email.to, ...(email.cc ?? [])]
	if (all.length > MAX_RECIPIENTS) {
		throw new GmailSendError('INVALID_EMAIL', `At most ${MAX_RECIPIENTS} recipients are allowed.`)
	}
	const body = Buffer.from(email.body.replace(/\r?\n/g, '\r\n'), 'utf8')
		.toString('base64')
		.replace(/(.{76})/g, '$1\r\n')
	return [
		`To: ${email.to.map(formatRecipient).join(', ')}`,
		...(email.cc?.length ? [`Cc: ${email.cc.map(formatRecipient).join(', ')}`] : []),
		`Subject: ${encodeHeaderText(email.subject)}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=UTF-8',
		'Content-Transfer-Encoding: base64',
		'',
		body,
	].join('\r\n')
}

async function describeFailure(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: { message?: string } }
		return body.error?.message ?? res.statusText
	} catch {
		return res.statusText
	}
}

/**
 * Send one email as the connected account. Status handling is deliberately split:
 * a 4xx means Gmail refused it (nothing was sent); anything else, including a network
 * failure, might have been sent, and must not be retried blindly.
 */
export async function sendEmail(
	accessToken: string,
	email: OutgoingEmail,
): Promise<{ messageId: string; threadId: string | null }> {
	const raw = Buffer.from(buildMimeMessage(email), 'utf8').toString('base64url')

	let res: Response
	try {
		res = await fetch(`${GMAIL_API_BASE}/messages/send`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ raw }),
		})
	} catch {
		throw new GmailSendError(
			'UNKNOWN_OUTCOME',
			'The connection to Gmail failed while sending. The email may or may not have been sent: check the Sent folder before trying again.',
		)
	}

	if (!res.ok) {
		const detail = await describeFailure(res)
		if (res.status === 401) {
			throw new GmailSendError(
				'RECONSENT_REQUIRED',
				'Gmail rejected the saved login. A person needs to reconnect Gmail in Settings → Integrations.',
				res.status,
			)
		}
		if (res.status === 403 && /scope|insufficient/i.test(detail)) {
			throw new GmailSendError(
				'INSUFFICIENT_SCOPE',
				'This Gmail connection is not allowed to send. A person needs to reconnect Gmail in Settings → Integrations.',
				res.status,
			)
		}
		if (res.status >= 400 && res.status < 500) {
			throw new GmailSendError('REJECTED', `Gmail refused the email: ${detail}`, res.status)
		}
		throw new GmailSendError(
			'UNKNOWN_OUTCOME',
			`Gmail returned an error (${res.status}) while sending. The email may or may not have been sent: check the Sent folder before trying again.`,
			res.status,
		)
	}

	const sent = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string }
	if (!sent.id) {
		throw new GmailSendError(
			'UNKNOWN_OUTCOME',
			'Gmail did not confirm the send. Check the Sent folder before trying again.',
			res.status,
		)
	}
	return { messageId: sent.id, threadId: sent.threadId ?? null }
}
