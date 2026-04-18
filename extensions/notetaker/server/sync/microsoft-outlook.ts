/**
 * Thin wrapper around Microsoft Graph's /me/events endpoint used by the notetaker
 * `/sync-calendars` route. Given an OAuth2 access token, fetches upcoming calendar
 * events and returns them in the same normalized shape as the Google variant.
 *
 * Token acquisition (including refresh) is the caller's responsibility — this
 * module is intentionally unaware of the integrations table or encryption.
 */

import type { NormalizedCalendarEvent } from './google-calendar.js'

interface GraphDateTimeTimeZone {
	dateTime?: string
	timeZone?: string
}

interface GraphOnlineMeetingInfo {
	joinUrl?: string
}

interface GraphEvent {
	id?: string
	isCancelled?: boolean
	subject?: string
	bodyPreview?: string
	start?: GraphDateTimeTimeZone
	end?: GraphDateTimeTimeZone
	onlineMeeting?: GraphOnlineMeetingInfo | null
	onlineMeetingUrl?: string | null
}

interface GraphEventsListResponse {
	value?: GraphEvent[]
}

const API_BASE = 'https://graph.microsoft.com/v1.0'

function graphDateTimeToIso(dt: GraphDateTimeTimeZone | undefined): string | null {
	if (!dt?.dateTime) return null
	// Graph returns "yyyy-MM-ddTHH:mm:ss(.fff)" without a trailing Z; assume UTC when
	// the timezone is UTC (the default for /me/events with Prefer outlook.timezone).
	const bare = dt.dateTime.endsWith('Z') ? dt.dateTime : `${dt.dateTime}Z`
	const parsed = new Date(bare)
	if (Number.isNaN(parsed.getTime())) return null
	return parsed.toISOString()
}

function extractMeetingUrl(event: GraphEvent): string | null {
	if (event.onlineMeeting?.joinUrl) return event.onlineMeeting.joinUrl
	if (event.onlineMeetingUrl) return event.onlineMeetingUrl
	return null
}

/**
 * List upcoming events from the signed-in user's Outlook calendar.
 * Filters out cancelled events and events with no resolvable start time.
 */
export async function listOutlookEvents(
	accessToken: string,
	options: { timeMin?: Date; maxResults?: number } = {},
): Promise<NormalizedCalendarEvent[]> {
	const { timeMin = new Date(), maxResults = 50 } = options
	const params = new URLSearchParams({
		$orderby: 'start/dateTime',
		$top: String(maxResults),
		$filter: `start/dateTime ge '${timeMin.toISOString()}'`,
	})
	const url = `${API_BASE}/me/events?${params}`
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Prefer: 'outlook.timezone="UTC"',
		},
	})
	if (!response.ok) {
		throw new Error(`Outlook events list failed: ${response.status} ${await response.text()}`)
	}
	const data = (await response.json()) as GraphEventsListResponse
	const events = data.value ?? []
	return events.flatMap((event) => {
		if (event.isCancelled || !event.id) return []
		const startTime = graphDateTimeToIso(event.start)
		if (!startTime) return []
		return [
			{
				calendarEventId: event.id,
				meetingUrl: extractMeetingUrl(event),
				startTime,
				endTime: graphDateTimeToIso(event.end),
				title: event.subject ?? null,
				description: event.bodyPreview ?? null,
			},
		]
	})
}
