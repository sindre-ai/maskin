/**
 * Reading Google Calendar through the Calendar API (`www.googleapis.com/calendar/v3`), the same
 * API the normal Google sign-in already covers. Google's hosted Calendar tool server can refuse
 * our sign-in with a 401 while this API accepts the same token, so these calls keep agents
 * reading calendars when the hosted tools are down. The hosted tools are not replaced.
 *
 * Read only: only GET addresses are built, and nothing here creates or changes an event. The
 * calendar list and the events are trimmed to the fields an agent needs, and every id, time and
 * page token is checked before it reaches a URL.
 */

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'

export const CALENDAR_DEFAULT_RESULTS = 25
export const CALENDAR_EVENTS_MAX_RESULTS = 50
/** Days one list call looks ahead when no window is given. */
export const CALENDAR_DEFAULT_FUTURE_DAYS = 30
/** Longest window one call may ask for, so a call cannot page through years of events. */
export const CALENDAR_MAX_WINDOW_DAYS = 366
const DAY_MS = 86_400_000
const MAX_QUERY_LENGTH = 200
/** Attendees kept per event; a company-wide invite would otherwise fill an agent's context. */
const MAX_ATTENDEES = 20

// A calendar id is "primary", an email address, or one of Google's own ids such as
// "en.usa#holiday@group.v.calendar.google.com". Only these characters are allowed, and "." and
// ".." are refused, so a value cannot add a path segment to the URL.
const CALENDAR_ID_RE = /^[A-Za-z0-9_.@#+-]{1,255}$/
const PAGE_TOKEN_RE = /^[A-Za-z0-9_.-]{1,512}$/

export type CalendarErrorCode =
	| 'INVALID_INPUT'
	| 'NOT_FOUND'
	| 'INSUFFICIENT_SCOPE'
	| 'RECONSENT_REQUIRED'
	| 'REJECTED'
	| 'UNAVAILABLE'

export class CalendarError extends Error {
	constructor(
		readonly code: CalendarErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'CalendarError'
	}
}

async function calendarCall<T>(
	accessToken: string,
	path: string,
	params?: URLSearchParams,
): Promise<T> {
	const url = `${CALENDAR_API_BASE}${path}${params ? `?${params}` : ''}`
	let res: Response
	try {
		res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
	} catch {
		throw new CalendarError('UNAVAILABLE', 'The connection to Google Calendar failed. Try again.')
	}
	if (res.ok) return (await res.json()) as T

	let detail = res.statusText
	try {
		detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? detail
	} catch {
		// keep the status text
	}
	if (res.status === 401) {
		throw new CalendarError(
			'RECONSENT_REQUIRED',
			'Google Calendar rejected the saved login. A person needs to reconnect Google Calendar in Settings → Integrations.',
		)
	}
	if (res.status === 403 && /scope|insufficient|permission/i.test(detail)) {
		throw new CalendarError(
			'INSUFFICIENT_SCOPE',
			'This Google Calendar connection is not allowed to do that. A person needs to reconnect Google Calendar in Settings → Integrations.',
		)
	}
	if (res.status === 404) {
		throw new CalendarError(
			'NOT_FOUND',
			'Google Calendar has no such calendar or event in the connected account. Check the id with google_calendar_list_calendars.',
		)
	}
	if (res.status >= 400 && res.status < 500) {
		throw new CalendarError('REJECTED', `Google Calendar refused the request: ${detail}`)
	}
	throw new CalendarError(
		'UNAVAILABLE',
		`Google Calendar returned an error (${res.status}). Try again.`,
	)
}

function assertCalendarId(value: string) {
	if (!CALENDAR_ID_RE.test(value) || value === '.' || value === '..') {
		throw new CalendarError(
			'INVALID_INPUT',
			'That is not a calendar id. Use an id from google_calendar_list_calendars, or "primary".',
		)
	}
}

// ---- calendars ----------------------------------------------------------------------------

interface RawCalendarListEntry {
	id?: string
	summary?: string
	primary?: boolean
	accessRole?: string
	timeZone?: string
}

export interface CalendarListEntry {
	calendar_id: string
	summary: string
	primary: boolean
	access_role: string
	time_zone: string | null
}

export interface CalendarList {
	calendars: CalendarListEntry[]
	next_page_token: string | null
}

/** The calendars the connected account can see, primary first as Google orders them. */
export async function listCalendars(
	accessToken: string,
	input: { pageToken?: string } = {},
): Promise<CalendarList> {
	if (input.pageToken !== undefined && !PAGE_TOKEN_RE.test(input.pageToken)) {
		throw new CalendarError('INVALID_INPUT', 'That is not a Google Calendar page token.')
	}
	const params = new URLSearchParams({
		maxResults: '250',
		fields: 'items(id,summary,primary,accessRole,timeZone),nextPageToken',
	})
	if (input.pageToken) params.set('pageToken', input.pageToken)
	const data = await calendarCall<{
		items?: RawCalendarListEntry[]
		nextPageToken?: string
	}>(accessToken, '/users/me/calendarList', params)
	return {
		calendars: (data.items ?? []).flatMap((item) =>
			item.id
				? [
						{
							calendar_id: item.id,
							summary: item.summary ?? item.id,
							primary: item.primary ?? false,
							access_role: item.accessRole ?? 'reader',
							time_zone: item.timeZone ?? null,
						},
					]
				: [],
		),
		next_page_token: data.nextPageToken ?? null,
	}
}

// ---- events -------------------------------------------------------------------------------

interface RawCalendarEvent {
	id?: string
	summary?: string
	status?: string
	start?: { date?: string; dateTime?: string }
	end?: { date?: string; dateTime?: string }
	location?: string
	organizer?: { email?: string; displayName?: string; self?: boolean }
	attendees?: Array<{
		email?: string
		displayName?: string
		responseStatus?: string
		organizer?: boolean
		self?: boolean
	}>
	htmlLink?: string
}

export interface CalendarEventAttendee {
	email: string
	name: string
	response_status: string
	organizer: boolean
	self: boolean
}

export interface CalendarEventOrganizer {
	email: string
	name: string
	self: boolean
}

export interface CalendarEvent {
	event_id: string
	calendar_id: string
	summary: string
	/** ISO time with its offset, or the date for an all-day event. */
	start: string
	end: string
	all_day: boolean
	location: string
	organizer: CalendarEventOrganizer | null
	/** The first attendees, capped at 20; see attendee_count. */
	attendees: CalendarEventAttendee[]
	attendee_count: number
	attendees_truncated: boolean
	/** Whether the connected calendar's owner is on the invite. */
	self_attending: boolean
	/** Their answer ("accepted", "declined", "tentative", "needsAction"), when they are on it. */
	self_response: string | null
	status: string
	html_link: string | null
}

function trimEvent(event: RawCalendarEvent, calendarId: string): CalendarEvent {
	const all = event.attendees ?? []
	const me = all.find((a) => a.self)
	const attendees = all.slice(0, MAX_ATTENDEES).flatMap((a) =>
		a.email
			? [
					{
						email: a.email,
						name: a.displayName ?? '',
						response_status: a.responseStatus ?? 'needsAction',
						organizer: a.organizer ?? false,
						self: a.self ?? false,
					},
				]
			: [],
	)
	return {
		event_id: event.id ?? '',
		calendar_id: calendarId,
		summary: event.summary ?? '(no title)',
		start: event.start?.dateTime ?? event.start?.date ?? '',
		end: event.end?.dateTime ?? event.end?.date ?? '',
		all_day: Boolean(event.start?.date),
		location: event.location ?? '',
		organizer: event.organizer?.email
			? {
					email: event.organizer.email,
					name: event.organizer.displayName ?? '',
					self: event.organizer.self ?? false,
				}
			: null,
		attendees,
		attendee_count: all.length,
		attendees_truncated: all.length > attendees.length,
		self_attending: me !== undefined,
		self_response: me?.responseStatus ?? null,
		status: event.status ?? 'confirmed',
		html_link: event.htmlLink ?? null,
	}
}

export interface ListEventsInput {
	calendarId?: string
	timeMin?: string
	timeMax?: string
	maxResults?: number
	query?: string
	pageToken?: string
	/** "Now" for the default window; tests pass a fixed instant. */
	now?: Date
}

export interface CalendarEvents {
	calendar_id: string
	time_min: string
	time_max: string
	events: CalendarEvent[]
	next_page_token: string | null
}

function parseWhen(value: string, field: string): Date {
	const when = new Date(value)
	if (Number.isNaN(when.getTime())) {
		throw new CalendarError(
			'INVALID_INPUT',
			`${field} must be a date and time with an offset, such as 2026-11-27T09:00:00Z.`,
		)
	}
	return when
}

/**
 * Events in a time window, in start order, with recurring events expanded. Defaults to the next
 * 30 days; a call may ask for any window up to 366 days.
 */
export async function listEvents(
	accessToken: string,
	input: ListEventsInput,
): Promise<CalendarEvents> {
	const calendarId = input.calendarId?.trim() || 'primary'
	assertCalendarId(calendarId)

	if (input.pageToken !== undefined && !PAGE_TOKEN_RE.test(input.pageToken)) {
		throw new CalendarError('INVALID_INPUT', 'That is not a Google Calendar page token.')
	}
	const query = (input.query ?? '').trim()
	if (query.length > MAX_QUERY_LENGTH) {
		throw new CalendarError(
			'INVALID_INPUT',
			`The search is over ${MAX_QUERY_LENGTH} characters. Make it shorter.`,
		)
	}

	const now = input.now ?? new Date()
	const from = input.timeMin ? parseWhen(input.timeMin, 'time_min') : now
	const to = input.timeMax
		? parseWhen(input.timeMax, 'time_max')
		: new Date(from.getTime() + CALENDAR_DEFAULT_FUTURE_DAYS * DAY_MS)
	if (to.getTime() <= from.getTime()) {
		throw new CalendarError('INVALID_INPUT', 'time_max must be after time_min.')
	}
	if (to.getTime() - from.getTime() > CALENDAR_MAX_WINDOW_DAYS * DAY_MS) {
		throw new CalendarError(
			'INVALID_INPUT',
			`One call may look at most ${CALENDAR_MAX_WINDOW_DAYS} days ahead. Narrow time_max.`,
		)
	}

	const max = Math.min(
		Math.max(Math.trunc(input.maxResults ?? CALENDAR_DEFAULT_RESULTS), 1),
		CALENDAR_EVENTS_MAX_RESULTS,
	)
	const params = new URLSearchParams({
		timeMin: from.toISOString(),
		timeMax: to.toISOString(),
		singleEvents: 'true',
		orderBy: 'startTime',
		maxResults: String(max),
		fields:
			'items(id,summary,status,start,end,location,organizer,attendees,htmlLink),nextPageToken',
	})
	if (query) params.set('q', query)
	if (input.pageToken) params.set('pageToken', input.pageToken)

	const data = await calendarCall<{
		items?: RawCalendarEvent[]
		nextPageToken?: string
	}>(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, params)
	return {
		calendar_id: calendarId,
		time_min: from.toISOString(),
		time_max: to.toISOString(),
		events: (data.items ?? []).map((event) => trimEvent(event, calendarId)),
		next_page_token: data.nextPageToken ?? null,
	}
}
