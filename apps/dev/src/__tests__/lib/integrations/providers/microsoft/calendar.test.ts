import { describe, expect, it } from 'vitest'
import {
	MAX_LIMIT,
	buildCancelRequest,
	buildCreateEventRequest,
	buildGetRequest,
	buildGuardRequest,
	buildListRequest,
	buildSearchRequest,
	buildUpdateEventRequest,
	editBlocker,
	matchesQuery,
	trimEvent,
} from '../../../../../lib/integrations/providers/microsoft/calendar'

const NOW = new Date('2026-11-12T10:00:00Z')

function params(url: string) {
	return new URL(url).searchParams
}

describe('buildListRequest', () => {
	it('defaults to the next 7 days from now, in start order, as one page plus one', () => {
		const built = buildListRequest({}, NOW)
		if (!built.ok) throw new Error(built.message)
		const q = params(built.url)
		expect(built.url).toContain('https://graph.microsoft.com/v1.0/me/calendarView?')
		expect(q.get('startDateTime')).toBe('2026-11-12T10:00:00.000Z')
		expect(q.get('endDateTime')).toBe('2026-11-19T10:00:00.000Z')
		expect(q.get('$orderby')).toBe('start/dateTime')
		expect(q.get('$top')).toBe('26')
		expect(built.limit).toBe(25)
	})

	it('keeps the default length when only one end is given', () => {
		const built = buildListRequest({ from: '2026-11-13T00:00:00+01:00' }, NOW)
		if (!built.ok) throw new Error(built.message)
		expect(params(built.url).get('startDateTime')).toBe('2026-11-12T23:00:00.000Z')
		expect(params(built.url).get('endDateTime')).toBe('2026-11-19T23:00:00.000Z')
	})

	it('caps the limit', () => {
		const built = buildListRequest({ limit: 5_000 }, NOW)
		if (!built.ok) throw new Error(built.message)
		expect(built.limit).toBe(MAX_LIMIT)
		expect(params(built.url).get('$top')).toBe(String(MAX_LIMIT + 1))
	})

	it('refuses a bad date, a backwards window and a window over a year', () => {
		expect(buildListRequest({ from: 'tomorrow-ish' }, NOW).ok).toBe(false)
		expect(buildListRequest({ from: '2026-11-20', to: '2026-11-13' }, NOW).ok).toBe(false)
		expect(buildListRequest({ from: '2024-01-01', to: '2026-01-01' }, NOW).ok).toBe(false)
	})

	it('only ever builds a GET address on the signed-in user', () => {
		const built = buildListRequest({}, NOW)
		if (!built.ok) throw new Error(built.message)
		expect(built.url.startsWith('https://graph.microsoft.com/v1.0/me/')).toBe(true)
	})
})

describe('buildSearchRequest', () => {
	it('defaults to 30 days back and 90 ahead and keeps the trimmed query', () => {
		const built = buildSearchRequest({ query: '  standup ' }, NOW)
		if (!built.ok) throw new Error(built.message)
		expect(built.query).toBe('standup')
		expect(params(built.url).get('startDateTime')).toBe('2026-10-13T10:00:00.000Z')
		expect(params(built.url).get('endDateTime')).toBe('2027-02-10T10:00:00.000Z')
	})

	it('refuses an empty query', () => {
		expect(buildSearchRequest({ query: '   ' }, NOW).ok).toBe(false)
	})
})

describe('buildGetRequest', () => {
	it('encodes the whole id, so characters like = and / stay inside the path segment', () => {
		const built = buildGetRequest('AAMk/ADA=+x')
		if (!built.ok) throw new Error(built.message)
		expect(built.url).toContain('/me/events/AAMk%2FADA%3D%2Bx?')
	})

	it('refuses a blank id', () => {
		expect(buildGetRequest('  ').ok).toBe(false)
	})
})

const RAW = {
	id: 'ev-1',
	subject: 'Quarterly review',
	start: { dateTime: '2026-11-13T09:00:00.0000000', timeZone: 'UTC' },
	end: { dateTime: '2026-11-13T10:00:00.0000000', timeZone: 'UTC' },
	isAllDay: false,
	showAs: 'busy',
	type: 'occurrence',
	location: { displayName: 'Room Fjord' },
	organizer: { emailAddress: { name: 'Mette Holm', address: 'mette@example.com' } },
	attendees: [
		{
			emailAddress: { name: 'Jonas Berg', address: 'jonas@example.com' },
			status: { response: 'accepted' },
		},
	],
	onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
	bodyPreview: 'Agenda: budget and hiring',
	webLink: 'https://outlook.office.com/calendar/item/1',
	originalStartTimeZone: 'W. Europe Standard Time',
}

describe('trimEvent', () => {
	it('marks Graph times as UTC and keeps only what an agent needs', () => {
		const e = trimEvent(RAW)
		expect(e.start).toBe('2026-11-13T09:00:00.0000000Z')
		expect(e.end).toBe('2026-11-13T10:00:00.0000000Z')
		expect(e.organizer).toEqual({ name: 'Mette Holm', email: 'mette@example.com' })
		expect(e.attendees).toEqual([
			{ name: 'Jonas Berg', email: 'jonas@example.com', response: 'accepted' },
		])
		expect(e.online_meeting_url).toBe('https://teams.microsoft.com/l/meetup-join/abc')
		expect(e.recurring).toBe(true)
		expect('body' in e).toBe(false)
	})

	it('caps attendees but reports the total, and cuts a long description when opened', () => {
		const many = Array.from({ length: 30 }, (_, n) => ({
			emailAddress: { name: `P${n}`, address: `p${n}@example.com` },
		}))
		const e = trimEvent({ ...RAW, attendees: many, body: { content: 'x'.repeat(10_000) } }, true)
		expect(e.attendees).toHaveLength(20)
		expect(e.attendees_total).toBe(30)
		expect(e.body?.length).toBeLessThan(4_100)
	})

	it('survives an event with almost nothing in it', () => {
		const e = trimEvent({})
		expect(e.subject).toBe('')
		expect(e.start).toBeNull()
		expect(e.attendees).toEqual([])
	})
})

describe('matchesQuery', () => {
	it('matches title, place, organizer, attendee and description, not case sensitive', () => {
		for (const q of ['QUARTERLY', 'fjord', 'mette@example', 'Jonas', 'hiring']) {
			expect(matchesQuery(RAW, q)).toBe(true)
		}
	})

	it('does not match text that is nowhere in the event', () => {
		expect(matchesQuery(RAW, 'dentist')).toBe(false)
	})
})

describe('event writes', () => {
	const fields = {
		subject: 'Planning',
		start: '2026-11-13T09:00:00+01:00',
		end: '2026-11-13T10:00:00Z',
	}

	it('builds a create with UTC wall-clock times and no attendees', () => {
		const built = buildCreateEventRequest(fields)
		if (!built.ok) throw new Error(built.message)
		expect(built.url).toBe('https://graph.microsoft.com/v1.0/me/events')
		expect(built.body).toEqual({
			subject: 'Planning',
			start: { dateTime: '2026-11-13T08:00:00.000', timeZone: 'UTC' },
			end: { dateTime: '2026-11-13T10:00:00.000', timeZone: 'UTC' },
		})
	})

	it('refuses an end before the start, an event over 7 days and an unreadable time', () => {
		expect(buildCreateEventRequest({ ...fields, end: fields.start }).ok).toBe(false)
		expect(buildCreateEventRequest({ ...fields, end: '2026-11-21T10:00:00Z' }).ok).toBe(false)
		expect(buildCreateEventRequest({ ...fields, start: 'soon' }).ok).toBe(false)
	})

	it('needs something to change, and start with end', () => {
		expect(buildUpdateEventRequest('ev-1', {}).ok).toBe(false)
		expect(buildUpdateEventRequest('ev-1', { start: fields.start }).ok).toBe(false)
		const built = buildUpdateEventRequest('a+b/c=', { subject: 'New' })
		if (!built.ok) throw new Error(built.message)
		expect(built.url).toBe('https://graph.microsoft.com/v1.0/me/events/a%2Bb%2Fc%3D')
		expect(built.body).toEqual({ subject: 'New' })
	})

	it('refuses an empty id for the read before a change and for a cancel', () => {
		expect(buildGuardRequest(' ').ok).toBe(false)
		expect(buildCancelRequest('').ok).toBe(false)
	})

	it('blocks an event with attendees or a series master, and lets a solo event through', () => {
		expect(editBlocker({ attendees: [{ emailAddress: { address: 'a@example.com' } }] })).toMatch(
			/other people/,
		)
		expect(editBlocker({ type: 'seriesMaster' })).toMatch(/recurring/)
		expect(editBlocker({ type: 'singleInstance', attendees: [] })).toBeNull()
		expect(editBlocker({ type: 'occurrence' })).toBeNull()
	})
})
