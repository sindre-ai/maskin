import type { Database } from '@maskin/db'
import { getIntegrationCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
// A live call is waiting on the answer: fail fast and let the agent fall back verbally.
const REQUEST_TIMEOUT_MS = 8_000

export interface BusyInterval {
	start: string
	end: string
}

export interface InsertEventInput {
	summary: string
	startIso: string
	endIso: string
	timeZone: string
	attendee: { email: string; displayName?: string }
	/** Idempotency for the Meet link request: the same id returns the same conference. */
	requestId: string
}

export interface InsertedEvent {
	eventId: string
	meetLink: string | null
}

/**
 * The two Calendar REST calls a voice booking needs. Reads and writes the primary
 * calendar of the workspace's connected google-calendar account. No retry: a
 * failure mid-call is the strict fallback in the tech spec (errata section 7).
 */
export interface CalendarApi {
	freeBusy(timeMinIso: string, timeMaxIso: string): Promise<BusyInterval[]>
	insertEvent(input: InsertEventInput): Promise<InsertedEvent>
}

export class CalendarApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
		this.name = 'CalendarApiError'
	}
}

async function call<T>(
	fetchImpl: typeof fetch,
	accessToken: string,
	method: 'GET' | 'POST',
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetchImpl(`${CALENDAR_API_BASE}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!res.ok) {
		const snippet = (await res.text().catch(() => '')).slice(0, 200)
		throw new CalendarApiError(res.status, `Google Calendar ${method} ${path} failed: ${snippet}`)
	}
	return (await res.json()) as T
}

interface FreeBusyResponse {
	calendars?: Record<string, { busy?: BusyInterval[]; errors?: unknown[] }>
}

interface EventResponse {
	id?: string
	hangoutLink?: string
	conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
}

export function createCalendarApi(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): CalendarApi {
	return {
		async freeBusy(timeMinIso, timeMaxIso) {
			const res = await call<FreeBusyResponse>(fetchImpl, accessToken, 'POST', '/freeBusy', {
				timeMin: timeMinIso,
				timeMax: timeMaxIso,
				items: [{ id: 'primary' }],
			})
			const primary = res.calendars?.primary
			// An errored calendar reads as "no busy blocks", which would offer slots that may
			// be taken. Treat it as a failure instead.
			if (!primary || (primary.errors?.length ?? 0) > 0) {
				throw new CalendarApiError(502, 'Google Calendar freeBusy returned no usable calendar')
			}
			return primary.busy ?? []
		},

		async insertEvent(input) {
			const res = await call<EventResponse>(
				fetchImpl,
				accessToken,
				'POST',
				// sendUpdates=none: the attendee is on the event, but Google sends the prospect no
				// email from this call. Whether a booking invite may go out is open (task comment).
				'/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none',
				{
					summary: input.summary,
					start: { dateTime: input.startIso, timeZone: input.timeZone },
					end: { dateTime: input.endIso, timeZone: input.timeZone },
					attendees: [{ email: input.attendee.email, displayName: input.attendee.displayName }],
					conferenceData: {
						createRequest: {
							requestId: input.requestId,
							conferenceSolutionKey: { type: 'hangoutsMeet' },
						},
					},
				},
			)
			if (!res.id) throw new CalendarApiError(502, 'Google Calendar insert returned no event id')
			const video = res.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')
			return { eventId: res.id, meetLink: video?.uri ?? res.hangoutLink ?? null }
		},
	}
}

/**
 * The workspace's Calendar client, or null when no active google-calendar
 * integration exists. Token refresh goes through the shared TokenManager.
 */
export async function resolveCalendarApi(
	db: Database,
	workspaceId: string,
): Promise<CalendarApi | null> {
	const integration = await getIntegrationCredential(db, workspaceId, 'google-calendar', null)
	if (!integration) return null
	const accessToken = await new TokenManager().getValidToken(
		db,
		integration.id,
		getProvider('google-calendar'),
	)
	return createCalendarApi(accessToken)
}
