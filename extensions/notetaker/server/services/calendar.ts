export interface CalendarEvent {
	id: string
	title: string
	start: string
	end: string
	videoLink: string | null
	attendees: string[]
	organizer: string
}

export type CalendarProvider = 'google-calendar' | 'outlook-calendar'

const VIDEO_LINK_PATTERNS = [
	/https:\/\/meet\.google\.com\/[a-z\-]+/i,
	/https:\/\/[\w.]*zoom\.us\/j\/\d+[^\s"]*/i,
	/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"]*/i,
	/https:\/\/[\w.]*webex\.com\/meet\/[^\s"]*/i,
]

/**
 * Extract a video meeting link from text content.
 * Scans for Google Meet, Zoom, Teams, and Webex URLs.
 */
export function extractVideoLink(text: string): string | null {
	for (const pattern of VIDEO_LINK_PATTERNS) {
		const match = text.match(pattern)
		if (match) return match[0]
	}
	return null
}

export async function fetchUpcomingMeetings(
	accessToken: string,
	provider: CalendarProvider,
	options?: { lookaheadMinutes?: number },
): Promise<CalendarEvent[]> {
	const lookahead = options?.lookaheadMinutes ?? 30
	const now = new Date()
	const end = new Date(now.getTime() + lookahead * 60 * 1000)

	if (provider === 'google-calendar') {
		return fetchGoogleEvents(accessToken, now.toISOString(), end.toISOString())
	}
	return fetchOutlookEvents(accessToken, now.toISOString(), end.toISOString())
}

// ── Google Calendar ───────────────────────────────────────────────────────

interface GoogleEvent {
	id: string
	summary?: string
	start?: { dateTime?: string; date?: string }
	end?: { dateTime?: string; date?: string }
	hangoutLink?: string
	conferenceData?: {
		entryPoints?: Array<{ entryPointType?: string; uri?: string }>
	}
	attendees?: Array<{ email?: string }>
	organizer?: { email?: string }
	description?: string
	location?: string
}

async function fetchGoogleEvents(
	accessToken: string,
	timeMin: string,
	timeMax: string,
): Promise<CalendarEvent[]> {
	const params = new URLSearchParams({
		timeMin,
		timeMax,
		singleEvents: 'true',
		orderBy: 'startTime',
	})

	const res = await fetch(
		`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
	)

	if (!res.ok) {
		throw new Error(`Google Calendar API error: ${res.status}`)
	}

	const data = (await res.json()) as { items?: GoogleEvent[] }
	return (data.items ?? []).map(normalizeGoogleEvent)
}

function normalizeGoogleEvent(event: GoogleEvent): CalendarEvent {
	// Extract video link: prefer conferenceData, then hangoutLink, then scan description/location
	let videoLink: string | null = null

	const videoEntry = event.conferenceData?.entryPoints?.find(
		(ep) => ep.entryPointType === 'video' && ep.uri,
	)
	if (videoEntry?.uri) {
		videoLink = videoEntry.uri
	} else if (event.hangoutLink) {
		videoLink = event.hangoutLink
	} else {
		const textToScan = [event.description, event.location].filter(Boolean).join(' ')
		if (textToScan) videoLink = extractVideoLink(textToScan)
	}

	return {
		id: event.id,
		title: event.summary ?? '(No title)',
		start: event.start?.dateTime ?? event.start?.date ?? '',
		end: event.end?.dateTime ?? event.end?.date ?? '',
		videoLink,
		attendees: (event.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
		organizer: event.organizer?.email ?? '',
	}
}

// ── Outlook Calendar ──────────────────────────────────────────────────────

interface OutlookEvent {
	id: string
	subject?: string
	start?: { dateTime?: string }
	end?: { dateTime?: string }
	onlineMeeting?: { joinUrl?: string }
	attendees?: Array<{ emailAddress?: { address?: string } }>
	organizer?: { emailAddress?: { address?: string } }
	body?: { content?: string }
	location?: { displayName?: string }
}

async function fetchOutlookEvents(
	accessToken: string,
	startDateTime: string,
	endDateTime: string,
): Promise<CalendarEvent[]> {
	const params = new URLSearchParams({ startDateTime, endDateTime })

	const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendarview?${params}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	})

	if (!res.ok) {
		throw new Error(`Outlook Calendar API error: ${res.status}`)
	}

	const data = (await res.json()) as { value?: OutlookEvent[] }
	return (data.value ?? []).map(normalizeOutlookEvent)
}

function normalizeOutlookEvent(event: OutlookEvent): CalendarEvent {
	let videoLink: string | null = event.onlineMeeting?.joinUrl ?? null

	if (!videoLink) {
		const textToScan = [event.body?.content, event.location?.displayName].filter(Boolean).join(' ')
		if (textToScan) videoLink = extractVideoLink(textToScan)
	}

	return {
		id: event.id,
		title: event.subject ?? '(No title)',
		start: event.start?.dateTime ?? '',
		end: event.end?.dateTime ?? '',
		videoLink,
		attendees: (event.attendees ?? []).map((a) => a.emailAddress?.address ?? '').filter(Boolean),
		organizer: event.organizer?.emailAddress?.address ?? '',
	}
}
