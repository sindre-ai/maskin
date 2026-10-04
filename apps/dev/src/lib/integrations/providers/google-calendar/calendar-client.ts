import { createHash, randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { IntegrationAuthRevokedError } from '../../errors'
import { getIntegrationCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
const REQUEST_TIMEOUT_MS = 8_000

/**
 * Whether Google emails the attendee an invite. none: the prospect never agreed to receive email,
 * so a Google invite would be a pre-sales message (errata section 8, CTO ruling 2026-10-03). Flip to
 * 'all' here, in one place, once the consent flow is signed off.
 */
export const CALENDAR_SEND_UPDATES = 'none' as const

/** A stable Google event id for one booking: the same call and slot always map to the same id. */
export function calendarEventId(...parts: string[]): string {
	// sha1 hex is 0-9a-f, inside the a-v0-9 alphabet Google accepts.
	return createHash('sha1').update(parts.join('|')).digest('hex')
}

export class CalendarError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = 'CalendarError'
	}
}

export interface BusyInterval {
	start: string
	end: string
}

export interface InsertedEvent {
	eventId: string
	meetLink: string
}

export interface CalendarClient {
	/** freebusy.query on the primary calendar. */
	freeBusy(timeMin: Date, timeMax: Date): Promise<BusyInterval[]>
	/** events.insert with the prospect as attendee and a Meet link. */
	insertEvent(input: {
		/**
		 * Caller-chosen id (Google accepts 5-1024 chars of a-v and 0-9). A second insert with the same
		 * id comes back as the event that already exists instead of a duplicate booking.
		 */
		eventId: string
		summary: string
		start: Date
		end: Date
		attendeeEmail: string
		attendeeName: string
	}): Promise<InsertedEvent>
}

export interface CalendarClientOptions {
	accessToken: string
	fetchImpl?: typeof fetch
	/** Test seam for the Meet conference request id. */
	requestId?: () => string
}

export function createCalendarClient(opts: CalendarClientOptions): CalendarClient {
	const doFetch = opts.fetchImpl ?? fetch

	async function call(method: string, url: string, body?: unknown): Promise<unknown> {
		const res = await doFetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${opts.accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		if (!res.ok) {
			const detail = await res.text().catch(() => '')
			throw new CalendarError(
				`Google Calendar ${method} failed with ${res.status}: ${detail.slice(0, 200)}`,
				res.status,
			)
		}
		return res.json()
	}

	return {
		async freeBusy(timeMin, timeMax) {
			const json = (await call('POST', `${CALENDAR_API}/freeBusy`, {
				timeMin: timeMin.toISOString(),
				timeMax: timeMax.toISOString(),
				items: [{ id: 'primary' }],
			})) as { calendars?: { primary?: { busy?: BusyInterval[]; errors?: unknown[] } } }
			const primary = json.calendars?.primary
			// An unreadable calendar must not read as an empty one: that would offer double bookings.
			if (!primary || (primary.errors?.length ?? 0) > 0) {
				throw new CalendarError('Google Calendar freeBusy returned no usable primary calendar', 502)
			}
			return primary.busy ?? []
		},

		async insertEvent(input) {
			const url = new URL(`${CALENDAR_API}/calendars/primary/events`)
			url.searchParams.set('sendUpdates', CALENDAR_SEND_UPDATES)
			url.searchParams.set('conferenceDataVersion', '1')
			let json: { id?: string; hangoutLink?: string }
			try {
				json = (await call('POST', url.toString(), {
					id: input.eventId,
					summary: input.summary,
					start: { dateTime: input.start.toISOString() },
					end: { dateTime: input.end.toISOString() },
					attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName }],
					conferenceData: {
						createRequest: {
							requestId: (opts.requestId ?? randomUUID)(),
							conferenceSolutionKey: { type: 'hangoutsMeet' },
						},
					},
				})) as { id?: string; hangoutLink?: string }
			} catch (err) {
				// 409: this booking already went through (a retry after a lost response).
				if (!(err instanceof CalendarError) || err.status !== 409) throw err
				json = (await call(
					'GET',
					`${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
				)) as { id?: string; hangoutLink?: string }
			}
			// A booking without a link is not a booking the agent can confirm out loud.
			if (!json.id || !json.hangoutLink) {
				throw new CalendarError('Google Calendar event came back without an id or Meet link', 502)
			}
			return { eventId: json.id, meetLink: json.hangoutLink }
		},
	}
}

/**
 * The workspace's Google Calendar access token (the provider is workspace-scoped). Null when no
 * active connection exists or the grant was revoked; the caller treats both as a calendar failure.
 */
export async function getCalendarAccessToken(
	db: Database,
	workspaceId: string,
): Promise<string | null> {
	const integration = await getIntegrationCredential(db, workspaceId, 'google-calendar', null)
	if (!integration) return null
	try {
		return await new TokenManager().getValidToken(
			db,
			integration.id,
			getProvider('google-calendar'),
		)
	} catch (err) {
		if (err instanceof IntegrationAuthRevokedError) return null
		throw err
	}
}
