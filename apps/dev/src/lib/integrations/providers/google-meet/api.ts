import { classifyGoogleFailure } from './errors'

/** Google Meet API v2 spaces.create shape (fields we use). */
export interface MeetSpaceConfig {
	accessType?: 'OPEN' | 'TRUSTED' | 'RESTRICTED'
	entryPointAccess?: 'ALL' | 'CREATOR_APP_ONLY'
	moderation?: 'ON' | 'OFF'
	moderationRestrictions?: {
		chatRestriction?: 'HOSTS_ONLY' | 'NO_RESTRICTION'
		presentRestriction?: 'HOSTS_ONLY' | 'NO_RESTRICTION'
		defaultJoinAsViewerType?: 'ON' | 'OFF'
	}
	artifactConfig?: {
		recordingConfig?: { autoRecordingGeneration?: 'ON' | 'OFF' }
		transcriptionConfig?: { autoTranscriptionGeneration?: 'ON' | 'OFF' }
		smartNotesConfig?: { autoSmartNotesGeneration?: 'ON' | 'OFF' }
	}
	attendanceReportGenerationType?: 'GENERATE_REPORT' | 'DO_NOT_GENERATE'
}

export interface MeetSpaceResponse {
	name: string
	meetingUri?: string
	meetingCode?: string
	config?: MeetSpaceConfig
}

export interface CreateMeetSpaceInput {
	accessToken: string
	config?: MeetSpaceConfig
	/** For error-classification hints — surfaces MEET_REQUIRES_WORKSPACE when Google flags a consumer account. */
	opContext?: string
}

/**
 * Call Meet v2 `spaces.create`. Returns the fresh space or throws a
 * `MeetToolError` shaped for the tool response envelope.
 *
 * The API accepts no client-side idempotency key — Maskin-side dedup lives
 * on top of this call (see idempotency.ts).
 */
export async function callMeetSpacesCreate(input: CreateMeetSpaceInput): Promise<MeetSpaceResponse> {
	const body: Record<string, unknown> = {}
	if (input.config) body.config = input.config

	const res = await fetch('https://meet.googleapis.com/v2/spaces', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${input.accessToken}`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const raw = await res.text()
		let parsed: unknown
		try {
			parsed = raw ? JSON.parse(raw) : undefined
		} catch {
			parsed = undefined
		}
		throw classifyGoogleFailure(res.status, parsed as never, {
			retryAfterHeader: res.headers.get('retry-after'),
			opContext: input.opContext,
		})
	}

	return (await res.json()) as MeetSpaceResponse
}

// ── Calendar events.insert (Meet-backed) ─────────────────────────────────────

export interface CalendarEventTime {
	date_time: string
	time_zone: string
}

export interface CalendarEventAttendee {
	email: string
	optional?: boolean
}

export interface CreateMeetBackedEventInput {
	accessToken: string
	calendarId?: string
	summary: string
	start: CalendarEventTime
	end: CalendarEventTime
	attendees?: CalendarEventAttendee[]
	description?: string
	/** Deterministic `conferenceData.createRequest.requestId`. Retries with the same value are replay-safe. */
	requestId: string
	opContext?: string
}

export interface CalendarEventResponse {
	id: string
	htmlLink?: string
	hangoutLink?: string
	summary?: string
	start?: { dateTime?: string; timeZone?: string }
	end?: { dateTime?: string; timeZone?: string }
	attendees?: Array<{ email: string; optional?: boolean; responseStatus?: string }>
	conferenceData?: {
		conferenceId?: string
		conferenceSolution?: { name?: string; iconUri?: string; key?: { type?: string } }
		entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>
	}
}

/**
 * `calendar.events.insert` with `conferenceDataVersion=1` + a Meet
 * `conferenceData.createRequest`. Closes bug ac295f51 natively — GCal
 * silently drops the conferenceData block when the version query param is
 * absent, which is the small-fix track's five-line fix and the primary path
 * we ship here.
 *
 * Google treats a repeated call with the same `createRequest.requestId` as a
 * replay: the second call returns the original event + Meet URI, no
 * duplicate space provisioned.
 */
export async function callCalendarEventsInsertWithMeet(
	input: CreateMeetBackedEventInput,
): Promise<{ event: CalendarEventResponse; meetUri: string; meetSpaceName: string }> {
	const calendarId = encodeURIComponent(input.calendarId ?? 'primary')
	const url =
		`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1`

	const body: Record<string, unknown> = {
		summary: input.summary,
		start: { dateTime: input.start.date_time, timeZone: input.start.time_zone },
		end: { dateTime: input.end.date_time, timeZone: input.end.time_zone },
		conferenceData: {
			createRequest: {
				requestId: input.requestId,
				conferenceSolutionKey: { type: 'hangoutsMeet' },
			},
		},
	}
	if (input.attendees?.length) body.attendees = input.attendees
	if (input.description) body.description = input.description

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${input.accessToken}`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const raw = await res.text()
		let parsed: unknown
		try {
			parsed = raw ? JSON.parse(raw) : undefined
		} catch {
			parsed = undefined
		}
		throw classifyGoogleFailure(res.status, parsed as never, {
			retryAfterHeader: res.headers.get('retry-after'),
			opContext: input.opContext,
		})
	}

	const event = (await res.json()) as CalendarEventResponse

	const meetEntry = (event.conferenceData?.entryPoints ?? []).find(
		(e) => e.entryPointType === 'video',
	)
	const meetUri = meetEntry?.uri ?? event.hangoutLink ?? ''
	// `conferenceData.conferenceId` is Meet's meeting code (e.g. abc-defg-hij).
	// The Meet API v2 uses `spaces/{space_name}` as the resource path — Google
	// returns the code, not the full path, on Calendar's response. The full
	// space name is resolved by Task 3's readback when the webhook fires; at
	// creation time the code + URI are the join keys the caller needs.
	const meetSpaceName = event.conferenceData?.conferenceId
		? `spaces/${event.conferenceData.conferenceId}`
		: ''

	return { event, meetUri, meetSpaceName }
}
