import { ApiErrorCode } from '@maskin/shared'

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
const REQUEST_TIMEOUT_MS = 10_000

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

async function googleFetch(
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

// ── Tool input/output shapes ───────────────────────────────────────────────

export interface CreateEventInput {
	calendarId: string
	title: string
	start: string
	end: string
	attendees?: string[]
	description?: string
	location?: string
}

export interface CreateEventOutput {
	eventId: string
	htmlLink: string | null
}

export interface UpdateEventChanges {
	title?: string
	start?: string
	end?: string
	attendees?: string[]
	description?: string
	location?: string
}

export interface UpdateEventInput {
	calendarId: string
	eventId: string
	changes: UpdateEventChanges
}

export interface UpdateEventOutput {
	eventId: string
	title?: string
	start?: string
	end?: string
	attendees?: string[]
	description?: string
	location?: string
	updated: string | null
}

export interface SendRsvpInput {
	calendarId: string
	eventId: string
	response: 'accepted' | 'tentative' | 'declined'
	/** Email of the attendee whose response we set — usually the connected user. */
	attendeeEmail: string
}

export interface SendRsvpOutput {
	eventId: string
	attendeeEmail: string
	response: 'accepted' | 'tentative' | 'declined'
}

interface GoogleEventResource {
	id: string
	htmlLink?: string
	summary?: string
	description?: string
	location?: string
	start?: { dateTime?: string; date?: string }
	end?: { dateTime?: string; date?: string }
	attendees?: Array<{ email: string; responseStatus?: string }>
	updated?: string
}

function startEnd(value: string): { dateTime?: string; date?: string } {
	// Bare `YYYY-MM-DD` → all-day; anything else → ISO datetime.
	return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value }
}

function attendeesList(emails?: string[]): Array<{ email: string }> | undefined {
	if (!emails) return undefined
	return emails.map((email) => ({ email }))
}

function pickAttendees(resource: GoogleEventResource | undefined): string[] | undefined {
	const list = resource?.attendees
	return list ? list.map((a) => a.email) : undefined
}

function pickStart(resource: GoogleEventResource | undefined): string | undefined {
	const s = resource?.start
	return s?.dateTime ?? s?.date
}

function pickEnd(resource: GoogleEventResource | undefined): string | undefined {
	const e = resource?.end
	return e?.dateTime ?? e?.date
}

// ── Tools ──────────────────────────────────────────────────────────────────

/**
 * Insert a new event on the named calendar.
 *
 * `idempotencyKey` is forwarded as Google's `events.insert?requestId=` query
 * parameter — Google dedupes server-side for 24h, so two calls with the same
 * key return the same event id (AC-T7).
 */
export async function createEvent(
	accessToken: string,
	input: CreateEventInput,
	idempotencyKey?: string,
): Promise<CreateEventOutput> {
	const body: Record<string, unknown> = {
		summary: input.title,
		start: startEnd(input.start),
		end: startEnd(input.end),
	}
	if (input.description) body.description = input.description
	if (input.location) body.location = input.location
	const attendees = attendeesList(input.attendees)
	if (attendees) body.attendees = attendees

	const params = new URLSearchParams()
	if (idempotencyKey) params.set('requestId', idempotencyKey)
	const query = params.toString()
	const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(input.calendarId)}/events${
		query ? `?${query}` : ''
	}`

	const res = await googleFetch(url, {
		accessToken,
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const resource = (await res.json()) as GoogleEventResource
	return {
		eventId: resource.id,
		htmlLink: resource.htmlLink ?? null,
	}
}

/**
 * Patch an existing event. Uses HTTP PATCH so only named fields are sent —
 * fields the agent didn't pass are left as-is on the Google side.
 *
 * On 412 Precondition Failed we map to `event_conflict` WITHOUT having
 * mutated anything: the PATCH itself is atomic (Google accepts the whole
 * patch or rejects it), so a 412 means the server-side state stayed put
 * (AC-T8).
 */
export async function updateEvent(
	accessToken: string,
	input: UpdateEventInput,
): Promise<UpdateEventOutput> {
	const patch: Record<string, unknown> = {}
	if (input.changes.title !== undefined) patch.summary = input.changes.title
	if (input.changes.description !== undefined) patch.description = input.changes.description
	if (input.changes.location !== undefined) patch.location = input.changes.location
	if (input.changes.start !== undefined) patch.start = startEnd(input.changes.start)
	if (input.changes.end !== undefined) patch.end = startEnd(input.changes.end)
	if (input.changes.attendees !== undefined)
		patch.attendees = attendeesList(input.changes.attendees)

	const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(
		input.calendarId,
	)}/events/${encodeURIComponent(input.eventId)}`

	const res = await googleFetch(url, {
		accessToken,
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(patch),
	})
	const resource = (await res.json()) as GoogleEventResource
	return {
		eventId: resource.id,
		title: resource.summary,
		start: pickStart(resource),
		end: pickEnd(resource),
		attendees: pickAttendees(resource),
		description: resource.description,
		location: resource.location,
		updated: resource.updated ?? null,
	}
}

/**
 * Set the named attendee's responseStatus on the event. Implemented by
 * fetching the current attendee list, replacing the target attendee's
 * `responseStatus`, and PATCHing the full list back — Google doesn't expose
 * a per-attendee endpoint, so the full-list patch is the only stable path.
 */
export async function sendRsvp(accessToken: string, input: SendRsvpInput): Promise<SendRsvpOutput> {
	const baseUrl = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(
		input.calendarId,
	)}/events/${encodeURIComponent(input.eventId)}`

	const fetchRes = await googleFetch(baseUrl, { accessToken, method: 'GET' })
	const current = (await fetchRes.json()) as GoogleEventResource

	const targetEmail = input.attendeeEmail.toLowerCase()
	const attendees = (current.attendees ?? []).map((a) =>
		a.email.toLowerCase() === targetEmail ? { ...a, responseStatus: input.response } : a,
	)
	// If the caller isn't already on the attendee list, attendee patching
	// would silently no-op; surface as a forbidden-style error instead.
	if (!attendees.some((a) => a.email.toLowerCase() === targetEmail)) {
		throw new GoogleCalendarError(
			ApiErrorCode.EVENT_FORBIDDEN,
			403,
			`Cannot RSVP — ${input.attendeeEmail} is not on the attendee list for this event.`,
		)
	}

	const patchRes = await googleFetch(baseUrl, {
		accessToken,
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ attendees }),
	})
	await patchRes.json()
	return {
		eventId: input.eventId,
		attendeeEmail: input.attendeeEmail,
		response: input.response,
	}
}
