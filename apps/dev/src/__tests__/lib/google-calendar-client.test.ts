import { describe, expect, it, vi } from 'vitest'
import {
	CalendarApiError,
	SEND_UPDATES,
	createCalendarApi,
} from '../../lib/integrations/providers/google-calendar/client'

function fetchReturning(status: number, body: unknown) {
	return vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status }),
	)
}

describe('google calendar client', () => {
	it('inserts on the primary calendar with the prospect as attendee, a Meet request and no invite email', async () => {
		const fetchImpl = fetchReturning(200, {
			id: 'ev1',
			conferenceData: {
				entryPoints: [
					{ entryPointType: 'phone', uri: 'tel:+1' },
					{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
				],
			},
		})
		const api = createCalendarApi('tok', fetchImpl as unknown as typeof fetch)
		const out = await api.insertEvent({
			summary: 'Maskin intro call: Pia',
			startIso: '2026-10-07T08:00:00.000Z',
			endIso: '2026-10-07T08:30:00.000Z',
			timeZone: 'Europe/Copenhagen',
			attendee: { email: 'pia@example.com', displayName: 'Pia' },
			requestId: 'req-1',
		})
		expect(out).toEqual({ eventId: 'ev1', meetLink: 'https://meet.google.com/abc-defg-hij' })
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
		expect(SEND_UPDATES).toBe('none')
		expect(url).toBe(
			'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none',
		)
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
		const body = JSON.parse(init.body as string)
		expect(body.attendees).toEqual([{ email: 'pia@example.com', displayName: 'Pia' }])
		expect(body.conferenceData.createRequest).toMatchObject({
			requestId: 'req-1',
			conferenceSolutionKey: { type: 'hangoutsMeet' },
		})
	})

	it('falls back to hangoutLink, and to null when Google returns no link at all', async () => {
		const input = {
			summary: 's',
			startIso: 'a',
			endIso: 'b',
			timeZone: 'UTC',
			attendee: { email: 'p@example.com' },
			requestId: 'r',
		}
		const withHangout = createCalendarApi(
			't',
			fetchReturning(200, {
				id: 'e',
				hangoutLink: 'https://meet.google.com/x',
			}) as unknown as typeof fetch,
		)
		expect((await withHangout.insertEvent(input)).meetLink).toBe('https://meet.google.com/x')
		const none = createCalendarApi('t', fetchReturning(200, { id: 'e' }) as unknown as typeof fetch)
		expect((await none.insertEvent(input)).meetLink).toBeNull()
	})

	it('throws on a non-2xx and on an insert with no event id', async () => {
		const input = {
			summary: 's',
			startIso: 'a',
			endIso: 'b',
			timeZone: 'UTC',
			attendee: { email: 'p@example.com' },
			requestId: 'r',
		}
		await expect(
			createCalendarApi(
				't',
				fetchReturning(503, { error: 'down' }) as unknown as typeof fetch,
			).insertEvent(input),
		).rejects.toBeInstanceOf(CalendarApiError)
		await expect(
			createCalendarApi('t', fetchReturning(200, {}) as unknown as typeof fetch).insertEvent(input),
		).rejects.toBeInstanceOf(CalendarApiError)
	})

	it('reads busy blocks from the primary calendar and refuses an errored calendar', async () => {
		const ok = createCalendarApi(
			't',
			fetchReturning(200, {
				calendars: { primary: { busy: [{ start: 'a', end: 'b' }] } },
			}) as unknown as typeof fetch,
		)
		expect(await ok.freeBusy('2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z')).toEqual([
			{ start: 'a', end: 'b' },
		])
		const errored = createCalendarApi(
			't',
			fetchReturning(200, {
				calendars: { primary: { errors: [{ reason: 'notFound' }] } },
			}) as unknown as typeof fetch,
		)
		await expect(errored.freeBusy('a', 'b')).rejects.toBeInstanceOf(CalendarApiError)
	})
})
