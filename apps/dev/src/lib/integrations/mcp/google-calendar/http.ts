import { ApiErrorCode } from '@maskin/shared'

export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * Mapped Google error → opaque code the agent sees. Carries an `httpStatus`
 * so callers (logs, tests) keep the upstream signal without leaking the raw
 * Google body to the agent — AC-T8 mandates that mapping is one-way.
 */
export class GoogleCalendarError extends Error {
	readonly code: ApiErrorCode
	readonly httpStatus: number

	constructor(code: ApiErrorCode, httpStatus: number, message: string) {
		super(message)
		this.name = 'GoogleCalendarError'
		this.code = code
		this.httpStatus = httpStatus
	}
}

interface GoogleErrorBody {
	error?: {
		code?: number
		message?: string
		status?: string
		errors?: Array<{ reason?: string; message?: string }>
	}
}

async function readBodySnippet(res: Response): Promise<string> {
	try {
		const text = await res.text()
		return text.slice(0, 200)
	} catch {
		return ''
	}
}

/**
 * Parse a Google error body without leaking the raw text — we look at the
 * `error.errors[].reason` field so callers can spot `invalid_grant` style
 * sub-codes without us forwarding the whole envelope.
 */
async function classifyError(res: Response): Promise<GoogleCalendarError> {
	const snippet = await readBodySnippet(res)
	let parsed: GoogleErrorBody | null = null
	try {
		parsed = JSON.parse(snippet) as GoogleErrorBody
	} catch {
		parsed = null
	}
	const reason = parsed?.error?.errors?.[0]?.reason ?? ''

	if (res.status === 401 || reason === 'invalid_grant' || reason === 'authError') {
		return new GoogleCalendarError(
			ApiErrorCode.AUTH_REVOKED,
			res.status,
			'Google Calendar grant is no longer valid — reconnect the integration.',
		)
	}
	if (res.status === 412) {
		return new GoogleCalendarError(
			ApiErrorCode.EVENT_CONFLICT,
			res.status,
			'Event changed since last read; refetch and retry without overwriting the conflicting fields.',
		)
	}
	if (res.status === 403) {
		return new GoogleCalendarError(
			ApiErrorCode.EVENT_FORBIDDEN,
			res.status,
			'Caller is not the organizer or an attendee of this event.',
		)
	}
	if (res.status === 404) {
		return new GoogleCalendarError(
			ApiErrorCode.EVENT_GONE,
			res.status,
			'Event no longer exists on the calendar.',
		)
	}
	if (res.status === 429) {
		return new GoogleCalendarError(
			ApiErrorCode.RATE_LIMITED,
			res.status,
			'Google Calendar rate limit hit — retry later with backoff.',
		)
	}
	return new GoogleCalendarError(
		ApiErrorCode.INTERNAL_ERROR,
		res.status,
		`Google Calendar request failed with HTTP ${res.status}.`,
	)
}

export async function googleFetch(
	url: string,
	init: RequestInit & { accessToken: string },
): Promise<Response> {
	const { accessToken, headers, ...rest } = init
	let res: Response
	try {
		res = await fetch(url, {
			...rest,
			headers: {
				...(headers as Record<string, string> | undefined),
				Authorization: `Bearer ${accessToken}`,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch (err) {
		if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			throw new GoogleCalendarError(
				ApiErrorCode.INTERNAL_ERROR,
				0,
				`Google Calendar request timed out after ${REQUEST_TIMEOUT_MS}ms`,
			)
		}
		throw err
	}
	if (!res.ok) {
		throw await classifyError(res)
	}
	return res
}
