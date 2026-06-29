import { CALENDAR_API_BASE, googleFetch } from './http'

// ── Tool input/output shapes ───────────────────────────────────────────────

export interface CalendarListEntry {
	id: string
	summary: string
	primary: boolean
	accessRole: string | null
	timeZone: string | null
}

export interface ListCalendarEventsInput {
	calendarId?: string
	timeMin: string
	timeMax: string
	maxResults?: number
}

export interface CalendarEventEntry {
	id: string
	summary: string | null
	description: string | null
	start: string | null
	end: string | null
	attendees: Array<{ email: string; responseStatus: string | null }>
	htmlLink: string | null
}

export interface GetFreeBusyInput {
	calendarIds: string[]
	timeMin: string
	timeMax: string
}

export interface FreeBusyEntry {
	calendarId: string
	busy: Array<{ start: string; end: string }>
}

interface CalendarListResource {
	items?: Array<{
		id: string
		summary?: string
		primary?: boolean
		accessRole?: string
		timeZone?: string
	}>
}

interface EventsListResource {
	items?: Array<{
		id: string
		summary?: string
		description?: string
		start?: { dateTime?: string; date?: string }
		end?: { dateTime?: string; date?: string }
		attendees?: Array<{ email: string; responseStatus?: string }>
		htmlLink?: string
	}>
}

interface FreeBusyResource {
	calendars?: Record<
		string,
		{
			busy?: Array<{ start: string; end: string }>
			errors?: Array<{ domain?: string; reason?: string }>
		}
	>
}

function pickDateOrDateTime(slot: { dateTime?: string; date?: string } | undefined): string | null {
	return slot?.dateTime ?? slot?.date ?? null
}

// ── Tools ──────────────────────────────────────────────────────────────────

/**
 * List the calendars the connected user has access to via
 * `calendarList.list`. Returned items are the *user's* subscription view, not
 * the global calendar registry — which is what the agent needs to decide
 * which calendar id to read or write against.
 */
export async function listCalendars(accessToken: string): Promise<CalendarListEntry[]> {
	const res = await googleFetch(`${CALENDAR_API_BASE}/users/me/calendarList`, {
		accessToken,
		method: 'GET',
	})
	const body = (await res.json()) as CalendarListResource
	const items = body.items ?? []
	return items.map((item) => ({
		id: item.id,
		summary: item.summary ?? item.id,
		primary: Boolean(item.primary),
		accessRole: item.accessRole ?? null,
		timeZone: item.timeZone ?? null,
	}))
}

/**
 * List events on a calendar (defaults to `primary`) inside a half-open time
 * range. Uses `singleEvents=true` so recurring events come back expanded —
 * what the agent reads matches what the user sees on their calendar grid,
 * not the raw recurrence rule.
 *
 * AC-U2 mandates `summary`, `start`, `end`, `attendees`, `description` come
 * through; we project those plus the Google `htmlLink` so the agent can give
 * the user a clickable reference back to the event.
 */
export async function listCalendarEvents(
	accessToken: string,
	input: ListCalendarEventsInput,
): Promise<CalendarEventEntry[]> {
	const calendarId = input.calendarId ?? 'primary'
	const params = new URLSearchParams({
		timeMin: input.timeMin,
		timeMax: input.timeMax,
		singleEvents: 'true',
		orderBy: 'startTime',
	})
	if (input.maxResults !== undefined) {
		params.set('maxResults', String(input.maxResults))
	}
	const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`

	const res = await googleFetch(url, { accessToken, method: 'GET' })
	const body = (await res.json()) as EventsListResource
	const items = body.items ?? []
	return items.map((item) => ({
		id: item.id,
		summary: item.summary ?? null,
		description: item.description ?? null,
		start: pickDateOrDateTime(item.start),
		end: pickDateOrDateTime(item.end),
		attendees: (item.attendees ?? []).map((a) => ({
			email: a.email,
			responseStatus: a.responseStatus ?? null,
		})),
		htmlLink: item.htmlLink ?? null,
	}))
}

/**
 * Query busy intervals across a list of calendars via `freebusy.query`. Each
 * returned entry mirrors one input calendar id (preserving the agent's order)
 * so the agent can correlate results back to the calendars it asked about —
 * Google's response keys by calendar id, we project that into a list keyed
 * the same way the input was. Calendars that errored at Google (e.g. the
 * user lost access to a shared calendar) come back with an empty `busy`
 * array rather than throwing the whole call — partial visibility is more
 * useful to the agent than an all-or-nothing failure.
 */
export async function getFreeBusy(
	accessToken: string,
	input: GetFreeBusyInput,
): Promise<FreeBusyEntry[]> {
	const res = await googleFetch(`${CALENDAR_API_BASE}/freeBusy`, {
		accessToken,
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			timeMin: input.timeMin,
			timeMax: input.timeMax,
			items: input.calendarIds.map((id) => ({ id })),
		}),
	})
	const body = (await res.json()) as FreeBusyResource
	const calendars = body.calendars ?? {}
	return input.calendarIds.map((calendarId) => {
		const entry = calendars[calendarId]
		return {
			calendarId,
			busy: entry?.busy ?? [],
		}
	})
}
