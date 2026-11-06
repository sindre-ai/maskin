import { describe, expect, it, vi } from 'vitest'
import {
	CALENDAR_SEND_UPDATES,
	CalendarError,
	calendarEventId,
	createCalendarClient,
} from '../../../lib/integrations/providers/google-calendar/calendar-client'

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

const event = {
	eventId: calendarEventId('call-1', '2026-10-06T08:00:00Z'),
	summary: 'Maskin intro call',
	start: new Date('2026-10-06T08:00:00Z'),
	end: new Date('2026-10-06T08:30:00Z'),
	attendeeEmail: 'anna@example.dk',
	attendeeName: 'Anna',
}

describe('calendar client', () => {
	it('inserts with sendUpdates none, conferenceDataVersion 1 and the prospect as attendee', async () => {
		const fetchImpl = vi.fn(async () =>
			json({ id: event.eventId, hangoutLink: 'https://meet.google.com/x' }),
		)
		const client = createCalendarClient({
			accessToken: 't',
			fetchImpl: fetchImpl as never,
			requestId: () => 'req-1',
		})
		const out = await client.insertEvent(event)
		expect(out).toEqual({ eventId: event.eventId, meetLink: 'https://meet.google.com/x' })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		const u = new URL(url)
		expect(CALENDAR_SEND_UPDATES).toBe('none')
		expect(u.searchParams.get('sendUpdates')).toBe('none')
		expect(u.searchParams.get('conferenceDataVersion')).toBe('1')
		const body = JSON.parse(String(init.body))
		expect(body.attendees).toEqual([{ email: 'anna@example.dk', displayName: 'Anna' }])
		expect(body.conferenceData.createRequest).toMatchObject({
			requestId: 'req-1',
			conferenceSolutionKey: { type: 'hangoutsMeet' },
		})
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t')
	})

	it('treats a 409 as the booking that already exists and fetches it', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(json({ error: 'duplicate' }, 409))
			.mockResolvedValueOnce(json({ id: event.eventId, hangoutLink: 'https://meet.google.com/x' }))
		const client = createCalendarClient({ accessToken: 't', fetchImpl: fetchImpl as never })
		expect((await client.insertEvent(event)).meetLink).toBe('https://meet.google.com/x')
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('fails an insert that comes back without a Meet link', async () => {
		const client = createCalendarClient({
			accessToken: 't',
			fetchImpl: (async () => json({ id: 'e' })) as never,
		})
		await expect(client.insertEvent(event)).rejects.toBeInstanceOf(CalendarError)
	})

	it('surfaces a Google error status', async () => {
		const client = createCalendarClient({
			accessToken: 't',
			fetchImpl: (async () => json({}, 503)) as never,
		})
		await expect(client.insertEvent(event)).rejects.toMatchObject({ status: 503 })
	})

	it('reads busy intervals and refuses an unreadable calendar', async () => {
		const busy = [{ start: '2026-10-06T08:00:00Z', end: '2026-10-06T09:00:00Z' }]
		const ok = createCalendarClient({
			accessToken: 't',
			fetchImpl: (async () => json({ calendars: { primary: { busy } } })) as never,
		})
		expect(await ok.freeBusy(new Date(), new Date())).toEqual(busy)
		const bad = createCalendarClient({
			accessToken: 't',
			fetchImpl: (async () =>
				json({ calendars: { primary: { errors: [{ reason: 'notFound' }] } } })) as never,
		})
		await expect(bad.freeBusy(new Date(), new Date())).rejects.toBeInstanceOf(CalendarError)
	})

	it('derives the same Google event id for the same call and slot, in the allowed alphabet', () => {
		const a = calendarEventId('call-1', 'x')
		expect(a).toBe(calendarEventId('call-1', 'x'))
		expect(a).not.toBe(calendarEventId('call-2', 'x'))
		expect(a).toMatch(/^[a-v0-9]{5,1024}$/)
	})
})
