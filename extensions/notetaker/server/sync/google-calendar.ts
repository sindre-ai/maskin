/**
 * Thin wrapper around Google Calendar API used by the notetaker `/sync-calendars`
 * route. Given an OAuth2 access token, fetches the primary calendar's upcoming
 * events and returns them in a normalized shape that the route handler can
 * upsert into `meeting` objects.
 *
 * Token acquisition (including refresh) is the caller's responsibility — this
 * module is intentionally unaware of the integrations table or encryption.
 */

export interface NormalizedCalendarEvent {
	calendarEventId: string
	meetingUrl: string | null
	startTime: string
	endTime: string | null
	title: string | null
	description: string | null
}

interface GoogleEventTime {
	dateTime?: string
	date?: string
}

interface GoogleConferenceEntryPoint {
	entryPointType?: string
	uri?: string
}

interface GoogleCalendarEvent {
	id?: string
	status?: string
	summary?: string
	description?: string
	hangoutLink?: string
	start?: GoogleEventTime
	end?: GoogleEventTime
	conferenceData?: {
		entryPoints?: GoogleConferenceEntryPoint[]
	}
}

interface GoogleEventsListResponse {
	items?: GoogleCalendarEvent[]
}

const API_BASE = 'https://www.googleapis.com/calendar/v3'

function extractMeetingUrl(event: GoogleCalendarEvent): string | null {
	if (event.hangoutLink) return event.hangoutLink
	for (const entry of event.conferenceData?.entryPoints ?? []) {
		if (entry.entryPointType === 'video' && entry.uri) return entry.uri
	}
	return null
}

function extractStartTime(event: GoogleCalendarEvent): string | null {
	return event.start?.dateTime ?? event.start?.date ?? null
}

function extractEndTime(event: GoogleCalendarEvent): string | null {
	return event.end?.dateTime ?? event.end?.date ?? null
}

/**
 * List upcoming events from the user's primary Google Calendar.
 * Filters out cancelled events and events with no resolvable start time.
 */
export async function listGoogleCalendarEvents(
	accessToken: string,
	options: { timeMin?: Date; maxResults?: number; calendarId?: string } = {},
): Promise<NormalizedCalendarEvent[]> {
	const { timeMin = new Date(), maxResults = 50, calendarId = 'primary' } = options
	const params = new URLSearchParams({
		timeMin: timeMin.toISOString(),
		maxResults: String(maxResults),
		singleEvents: 'true',
		orderBy: 'startTime',
	})
	const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!response.ok) {
		throw new Error(
			`Google Calendar events list failed: ${response.status} ${await response.text()}`,
		)
	}
	const data = (await response.json()) as GoogleEventsListResponse
	const events = data.items ?? []
	return events.flatMap((event) => {
		if (event.status === 'cancelled' || !event.id) return []
		const startTime = extractStartTime(event)
		if (!startTime) return []
		return [
			{
				calendarEventId: event.id,
				meetingUrl: extractMeetingUrl(event),
				startTime,
				endTime: extractEndTime(event),
				title: event.summary ?? null,
				description: event.description ?? null,
			},
		]
	})
}
