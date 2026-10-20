/**
 * Sending a Gmail draft. Google's hosted Gmail MCP only creates drafts, so this is
 * the one place Maskin itself calls `drafts.send`. `gmail.compose` (already in the
 * connect scopes) covers it, so no existing install needs to reconnect.
 *
 * Sending cannot be undone and Gmail has no idempotency key for it, so nothing here
 * retries: an ambiguous failure is reported, never repeated.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export type GmailSendErrorCode =
	| 'DRAFT_NOT_FOUND'
	| 'DRAFT_CHANGED'
	| 'INSUFFICIENT_SCOPE'
	| 'RECONSENT_REQUIRED'
	| 'PROVIDER_ERROR'

export class GmailSendError extends Error {
	constructor(
		readonly code: GmailSendErrorCode,
		message: string,
		readonly providerStatus: number,
	) {
		super(message)
		this.name = 'GmailSendError'
	}
}

export interface GmailDraftSummary {
	draftId: string
	/**
	 * Gmail replaces a draft's message id every time the draft is edited, so this
	 * doubles as a version: send it back to prove the draft is still the one that
	 * was shown.
	 */
	messageId: string
	threadId: string | null
	to: string
	cc: string
	subject: string
	snippet: string
}

interface DraftResponse {
	id?: string
	message?: {
		id?: string
		threadId?: string
		snippet?: string
		payload?: { headers?: Array<{ name?: string; value?: string }> }
	}
}

function header(draft: DraftResponse, name: string): string {
	const wanted = name.toLowerCase()
	const found = draft.message?.payload?.headers?.find((h) => h.name?.toLowerCase() === wanted)
	return found?.value ?? ''
}

async function describeFailure(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: { message?: string } }
		return body.error?.message ?? res.statusText
	} catch {
		return res.statusText
	}
}

/** Map a failed Gmail response to our error codes. Always throws. */
async function fail(res: Response): Promise<never> {
	const detail = await describeFailure(res)
	if (res.status === 404) {
		throw new GmailSendError(
			'DRAFT_NOT_FOUND',
			'That draft no longer exists. It may already have been sent or deleted.',
			res.status,
		)
	}
	if (res.status === 401) {
		throw new GmailSendError(
			'RECONSENT_REQUIRED',
			'Gmail rejected the saved login. Reconnect Gmail in Settings → Integrations.',
			res.status,
		)
	}
	if (res.status === 403 && /scope|insufficient/i.test(detail)) {
		throw new GmailSendError(
			'INSUFFICIENT_SCOPE',
			'This Gmail connection was not allowed to send. Reconnect Gmail in Settings → Integrations.',
			res.status,
		)
	}
	throw new GmailSendError('PROVIDER_ERROR', `Gmail error: ${detail}`, res.status)
}

export async function getDraftSummary(
	accessToken: string,
	draftId: string,
): Promise<GmailDraftSummary> {
	const url = new URL(`${GMAIL_API_BASE}/drafts/${encodeURIComponent(draftId)}`)
	url.searchParams.set('format', 'metadata')
	for (const name of ['To', 'Cc', 'Subject']) url.searchParams.append('metadataHeaders', name)

	const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
	if (!res.ok) return fail(res)

	const draft = (await res.json()) as DraftResponse
	if (!draft.id || !draft.message?.id) {
		throw new GmailSendError('PROVIDER_ERROR', 'Gmail returned a draft without an id.', res.status)
	}
	return {
		draftId: draft.id,
		messageId: draft.message.id,
		threadId: draft.message.threadId ?? null,
		to: header(draft, 'To'),
		cc: header(draft, 'Cc'),
		subject: header(draft, 'Subject'),
		snippet: draft.message.snippet ?? '',
	}
}

/**
 * Send a draft, but only if it is still the version the caller saw. An agent may
 * keep editing a draft while a person reads it; without this check the person's
 * click would send text they never read.
 */
export async function sendDraft(
	accessToken: string,
	draftId: string,
	expectedMessageId: string,
): Promise<{ messageId: string; threadId: string | null }> {
	const current = await getDraftSummary(accessToken, draftId)
	if (current.messageId !== expectedMessageId) {
		throw new GmailSendError(
			'DRAFT_CHANGED',
			'The draft was edited after you opened it. Review it again before sending.',
			409,
		)
	}

	const res = await fetch(`${GMAIL_API_BASE}/drafts/send`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ id: draftId }),
	})
	if (!res.ok) return fail(res)

	const sent = (await res.json()) as { id?: string; threadId?: string }
	if (!sent.id) {
		throw new GmailSendError(
			'PROVIDER_ERROR',
			'Gmail sent the draft but returned no id.',
			res.status,
		)
	}
	return { messageId: sent.id, threadId: sent.threadId ?? null }
}
