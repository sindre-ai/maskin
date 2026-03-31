const RECALL_REGION = process.env.RECALL_REGION || 'us-west-2'
const RECALL_API_URL = process.env.RECALL_API_URL || `https://${RECALL_REGION}.recall.ai/api/v1`
const RECALL_V2_BASE = process.env.RECALL_V2_BASE || `https://${RECALL_REGION}.recall.ai/api/v2`
const RECALL_API_KEY = process.env.RECALL_API_KEY || ''

export interface RecallBot {
	id: string
	meeting_url: string
	status_changes: Array<{
		code: string
		sub_code?: string
		created_at: string
	}>
	video_url: string | null
	bot_name: string
}

export interface CreateBotOptions {
	botName?: string
	joinAt?: string
}

function recallHeaders(): Record<string, string> {
	return {
		Authorization: `Token ${RECALL_API_KEY}`,
		'Content-Type': 'application/json',
	}
}

export async function createBot(
	meetingUrl: string,
	options?: CreateBotOptions,
): Promise<RecallBot> {
	const body: Record<string, unknown> = {
		meeting_url: meetingUrl,
	}
	if (options?.botName) body.bot_name = options.botName
	if (options?.joinAt) body.join_at = options.joinAt

	const res = await fetch(`${RECALL_API_URL}/bot`, {
		method: 'POST',
		headers: recallHeaders(),
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Recall API error (${res.status}): ${text}`)
	}

	return (await res.json()) as RecallBot
}

export async function getBot(botId: string): Promise<RecallBot> {
	const res = await fetch(`${RECALL_API_URL}/bot/${botId}`, {
		headers: recallHeaders(),
	})

	if (!res.ok) {
		throw new Error(`Recall API error (${res.status}): Failed to get bot ${botId}`)
	}

	return (await res.json()) as RecallBot
}

// ── Calendar V2 API ───────────────────────────────────────────────────────

export interface RecallCalendar {
	id: string
	platform: 'google_calendar' | 'microsoft_outlook'
	platform_email: string | null
	is_connected: boolean
}

export interface RecallCalendarEvent {
	id: string
	calendar_id: string
	meeting_url: string | null
	start_time: string
	end_time: string
	is_organizer: boolean
	is_deleted: boolean
	updated_at: string
	raw: Record<string, unknown>
	bots: Array<{
		id: string
		deduplication_key: string | null
	}>
}

interface PaginatedResponse<T> {
	next: string | null
	previous: string | null
	results: T[]
}

export async function createCalendar(
	platform: 'google_calendar' | 'microsoft_outlook',
	oauthRefreshToken: string,
	oauthClientId: string,
	oauthClientSecret: string,
): Promise<RecallCalendar> {
	const res = await fetch(`${RECALL_V2_BASE}/calendars/`, {
		method: 'POST',
		headers: recallHeaders(),
		body: JSON.stringify({
			platform,
			oauth_refresh_token: oauthRefreshToken,
			oauth_client_id: oauthClientId,
			oauth_client_secret: oauthClientSecret,
		}),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Recall Calendar API error (${res.status}): ${text}`)
	}

	return (await res.json()) as RecallCalendar
}

export async function listCalendarEvents(
	calendarId: string,
	updatedAfter?: string,
): Promise<RecallCalendarEvent[]> {
	const params = new URLSearchParams({ calendar_id: calendarId })
	if (updatedAfter) params.set('updated_at__gte', updatedAfter)

	const allEvents: RecallCalendarEvent[] = []
	let url: string | null = `${RECALL_V2_BASE}/calendar-events/?${params}`

	while (url) {
		const res = await fetch(url, { headers: recallHeaders() })
		if (!res.ok) {
			const text = await res.text()
			throw new Error(`Recall Calendar Events API error (${res.status}): ${text}`)
		}
		const page = (await res.json()) as PaginatedResponse<RecallCalendarEvent>
		allEvents.push(...page.results)
		url = page.next
	}

	return allEvents
}

export async function scheduleBotForEvent(
	eventId: string,
	deduplicationKey: string,
	botName?: string,
): Promise<RecallCalendarEvent> {
	const body: Record<string, unknown> = { deduplication_key: deduplicationKey }
	if (botName) body.bot_name = botName

	const res = await fetch(`${RECALL_V2_BASE}/calendar-events/${eventId}/bot/`, {
		method: 'POST',
		headers: recallHeaders(),
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Recall Schedule Bot API error (${res.status}): ${text}`)
	}

	return (await res.json()) as RecallCalendarEvent
}

export async function deleteBotFromEvent(eventId: string): Promise<void> {
	const res = await fetch(`${RECALL_V2_BASE}/calendar-events/${eventId}/bot/`, {
		method: 'DELETE',
		headers: recallHeaders(),
	})

	if (!res.ok && res.status !== 404) {
		const text = await res.text()
		throw new Error(`Recall Delete Bot API error (${res.status}): ${text}`)
	}
}

// ── Bot API ───────────────────────────────────────────────────────────────

export async function downloadRecording(videoUrl: string): Promise<Buffer> {
	const res = await fetch(videoUrl, {
		headers: recallHeaders(),
	})

	if (!res.ok) {
		throw new Error(`Failed to download recording (${res.status})`)
	}

	return Buffer.from(await res.arrayBuffer())
}
