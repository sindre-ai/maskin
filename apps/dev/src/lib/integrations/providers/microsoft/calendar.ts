import { GRAPH_BASE } from './graph'

/**
 * Outlook calendar reads for the Microsoft MCP tools (./mcp-server.ts). Pure: builds the Graph
 * addresses, validates what an agent passed, and trims events to the fields an agent needs. No
 * I/O here, so every rule is unit-tested without a server.
 *
 * Read only. Only GET addresses are built, and Calendars.Read cannot write anyway.
 */

export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 50

const DAY_MS = 86_400_000
/** Longest window one call may ask for, so a call cannot page through years of events. */
export const MAX_WINDOW_DAYS = 366
export const LIST_DEFAULT_DAYS = 7
export const SEARCH_DEFAULT_PAST_DAYS = 30
export const SEARCH_DEFAULT_FUTURE_DAYS = 90
/** Events read from Graph for one search (it matches here, not in Graph; see matchesQuery). */
export const SEARCH_SCAN_LIMIT = 500
const SEARCH_PAGE_SIZE = 100

const MAX_ID_LENGTH = 1_000
const MAX_ATTENDEES = 20
const MAX_PREVIEW_CHARS = 500
const MAX_BODY_CHARS = 4_000

const SUMMARY_SELECT = [
	'id',
	'subject',
	'start',
	'end',
	'isAllDay',
	'isCancelled',
	'showAs',
	'location',
	'organizer',
	'attendees',
	'onlineMeeting',
	'bodyPreview',
	'webLink',
	'originalStartTimeZone',
	'type',
].join(',')

/** Graph answers in UTC wall-clock time (no zone on the string) when it is sent this. */
export const UTC_HEADERS = { Prefer: 'outlook.timezone="UTC"' }
export const UTC_TEXT_HEADERS = {
	Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
}

export type Built<T> = ({ ok: true } & T) | { ok: false; message: string }

export interface Window {
	from: Date
	to: Date
}

function parseWhen(value: string, field: string): Date | string {
	const when = new Date(value)
	if (Number.isNaN(when.getTime())) {
		return `${field} must be a date such as 2026-11-13 or 2026-11-13T09:00:00+01:00.`
	}
	return when
}

/**
 * The time window for a call. A date with no time is read as midnight UTC, so give a time and
 * an offset to mean a local day. Missing ends default around `now`.
 */
export function resolveWindow(
	input: { from?: string; to?: string },
	now: Date,
	defaults: { pastDays: number; futureDays: number },
): Built<Window> {
	let from = new Date(now.getTime() - defaults.pastDays * DAY_MS)
	let to = new Date(now.getTime() + defaults.futureDays * DAY_MS)
	if (input.from !== undefined) {
		const parsed = parseWhen(input.from, 'from')
		if (typeof parsed === 'string') return { ok: false, message: parsed }
		from = parsed
		// Only one end given: keep the default length from that end.
		if (input.to === undefined) {
			to = new Date(from.getTime() + (defaults.pastDays + defaults.futureDays) * DAY_MS)
		}
	}
	if (input.to !== undefined) {
		const parsed = parseWhen(input.to, 'to')
		if (typeof parsed === 'string') return { ok: false, message: parsed }
		to = parsed
		if (input.from === undefined) {
			from = new Date(to.getTime() - (defaults.pastDays + defaults.futureDays) * DAY_MS)
		}
	}
	if (to.getTime() <= from.getTime()) return { ok: false, message: 'to must be after from.' }
	if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
		return {
			ok: false,
			message: `The window from from to to can be at most ${MAX_WINDOW_DAYS} days.`,
		}
	}
	return { ok: true, from, to }
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
	return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}

function calendarViewUrl(window: Window, top: number): string {
	const params = [
		`startDateTime=${encodeURIComponent(window.from.toISOString())}`,
		`endDateTime=${encodeURIComponent(window.to.toISOString())}`,
		`$top=${top}`,
		'$orderby=start/dateTime',
		`$select=${SUMMARY_SELECT}`,
	]
	return `${GRAPH_BASE}/me/calendarView?${params.join('&')}`
}

/** One page of events in a window, in start order. Asks for one more than `limit` to know if there is a next page. */
export function buildListRequest(
	input: { from?: string; to?: string; limit?: number },
	now: Date,
): Built<{ url: string; limit: number; window: Window }> {
	const window = resolveWindow(input, now, { pastDays: 0, futureDays: LIST_DEFAULT_DAYS })
	if (!window.ok) return window
	const limit = clampLimit(input.limit)
	return { ok: true, url: calendarViewUrl(window, limit + 1), limit, window }
}

/** The window search reads. Matching happens in matchesQuery, on what comes back. */
export function buildSearchRequest(
	input: { query: string; from?: string; to?: string; limit?: number },
	now: Date,
): Built<{ url: string; limit: number; query: string; window: Window }> {
	const query = input.query.trim()
	if (query === '') return { ok: false, message: 'query must not be empty.' }
	const window = resolveWindow(input, now, {
		pastDays: SEARCH_DEFAULT_PAST_DAYS,
		futureDays: SEARCH_DEFAULT_FUTURE_DAYS,
	})
	if (!window.ok) return window
	return {
		ok: true,
		url: calendarViewUrl(window, SEARCH_PAGE_SIZE),
		limit: clampLimit(input.limit),
		query,
		window,
	}
}

export function buildGetRequest(id: string): Built<{ url: string }> {
	const trimmed = id.trim()
	if (trimmed === '' || trimmed.length > MAX_ID_LENGTH) {
		return {
			ok: false,
			message: 'id must be an event id from outlook_list_events or outlook_search_events.',
		}
	}
	// Event ids hold characters that mean something in an address (=, +, /), so encode them whole.
	return {
		ok: true,
		url: `${GRAPH_BASE}/me/events/${encodeURIComponent(trimmed)}?$select=${SUMMARY_SELECT},body`,
	}
}

// ── Trimming ─────────────────────────────────────────────────────────────

interface GraphAddress {
	emailAddress?: { name?: string; address?: string }
}

export interface GraphEvent {
	id?: string
	subject?: string | null
	start?: { dateTime?: string; timeZone?: string }
	end?: { dateTime?: string; timeZone?: string }
	isAllDay?: boolean
	isCancelled?: boolean
	showAs?: string
	type?: string
	location?: { displayName?: string }
	organizer?: GraphAddress
	attendees?: Array<GraphAddress & { type?: string; status?: { response?: string } }>
	onlineMeeting?: { joinUrl?: string } | null
	bodyPreview?: string
	body?: { content?: string }
	webLink?: string
	originalStartTimeZone?: string
}

/** Graph sends UTC times without a zone mark; add it so the string is an unambiguous instant. */
function asUtc(dateTime: string | undefined): string | null {
	if (!dateTime) return null
	return /[zZ]|[+-]\d\d:\d\d$/.test(dateTime) ? dateTime : `${dateTime}Z`
}

function person(address: GraphAddress | undefined) {
	const name = address?.emailAddress?.name
	const email = address?.emailAddress?.address
	return { name: name || null, email: email || null }
}

function cut(text: string | undefined, max: number): string {
	const value = (text ?? '').trim()
	return value.length > max ? `${value.slice(0, max)}...` : value
}

export interface TrimmedEvent {
	id: string | null
	subject: string
	start: string | null
	end: string | null
	is_all_day: boolean
	is_cancelled: boolean
	show_as: string | null
	recurring: boolean
	location: string | null
	organizer: { name: string | null; email: string | null }
	attendees: Array<{ name: string | null; email: string | null; response: string | null }>
	attendees_total: number
	online_meeting_url: string | null
	web_link: string | null
	original_time_zone: string | null
	preview: string
	body?: string
}

/** The fields an agent needs, in UTC. `withBody` is for a single event opened by id. */
export function trimEvent(raw: GraphEvent, withBody = false): TrimmedEvent {
	const attendees = raw.attendees ?? []
	const out: TrimmedEvent = {
		id: raw.id ?? null,
		subject: raw.subject ?? '',
		start: asUtc(raw.start?.dateTime),
		end: asUtc(raw.end?.dateTime),
		is_all_day: raw.isAllDay === true,
		is_cancelled: raw.isCancelled === true,
		show_as: raw.showAs ?? null,
		recurring: raw.type === 'occurrence' || raw.type === 'exception' || raw.type === 'seriesMaster',
		location: raw.location?.displayName || null,
		organizer: person(raw.organizer),
		attendees: attendees.slice(0, MAX_ATTENDEES).map((a) => ({
			...person(a),
			response: a.status?.response ?? null,
		})),
		attendees_total: attendees.length,
		online_meeting_url: raw.onlineMeeting?.joinUrl ?? null,
		web_link: raw.webLink ?? null,
		original_time_zone: raw.originalStartTimeZone ?? null,
		preview: cut(raw.bodyPreview, MAX_PREVIEW_CHARS),
	}
	if (withBody) out.body = cut(raw.body?.content, MAX_BODY_CHARS)
	return out
}

/**
 * Case-insensitive match on the words people search a calendar by: title, place, organizer,
 * attendees and the start of the description. Done here and not with a Graph filter, so it does
 * not depend on which filter functions Graph supports for events.
 */
export function matchesQuery(raw: GraphEvent, query: string): boolean {
	const needle = query.toLowerCase()
	const fields = [
		raw.subject,
		raw.location?.displayName,
		raw.bodyPreview,
		raw.organizer?.emailAddress?.name,
		raw.organizer?.emailAddress?.address,
		...(raw.attendees ?? []).flatMap((a) => [a.emailAddress?.name, a.emailAddress?.address]),
	]
	return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(needle))
}
