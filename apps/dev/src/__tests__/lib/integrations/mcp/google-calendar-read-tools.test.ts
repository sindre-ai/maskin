import { ApiErrorCode } from '@maskin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleCalendarError } from '../../../../lib/integrations/mcp/google-calendar/http'
import {
	getFreeBusy,
	listCalendarEvents,
	listCalendars,
} from '../../../../lib/integrations/mcp/google-calendar/read-tools'

const ACCESS_TOKEN = 'ya29.test-token'

function mockResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
	const ok = init.ok ?? true
	const status = init.status ?? 200
	return {
		ok,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response
}

describe('listCalendars', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue(
			mockResponse({
				items: [
					{
						id: 'primary',
						summary: 'Magnus Calendar',
						primary: true,
						accessRole: 'owner',
						timeZone: 'Europe/Oslo',
					},
					{
						id: 'team-shared@group.calendar.google.com',
						summary: 'Team',
						accessRole: 'reader',
						timeZone: 'Europe/Oslo',
					},
				],
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('GETs calendarList.list with Bearer auth and projects the connected user view', async () => {
		const out = await listCalendars(ACCESS_TOKEN)

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList')
		expect(init.method).toBe('GET')
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)

		expect(out).toEqual([
			{
				id: 'primary',
				summary: 'Magnus Calendar',
				primary: true,
				accessRole: 'owner',
				timeZone: 'Europe/Oslo',
			},
			{
				id: 'team-shared@group.calendar.google.com',
				summary: 'Team',
				primary: false,
				accessRole: 'reader',
				timeZone: 'Europe/Oslo',
			},
		])
	})

	it('returns an empty list when Google sends no items', async () => {
		fetchMock.mockResolvedValueOnce(mockResponse({}))
		const out = await listCalendars(ACCESS_TOKEN)
		expect(out).toEqual([])
	})

	it('maps Google 401 to AUTH_REVOKED (AC-T3)', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse(
				{ error: { code: 401, errors: [{ reason: 'authError' }] } },
				{ ok: false, status: 401 },
			),
		)
		await expect(listCalendars(ACCESS_TOKEN)).rejects.toMatchObject({
			code: ApiErrorCode.AUTH_REVOKED,
			httpStatus: 401,
		})
	})
})

describe('listCalendarEvents', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue(
			mockResponse({
				items: [
					{
						id: 'evt-1',
						summary: 'Strategy sync',
						description: 'Quarterly bet review',
						start: { dateTime: '2026-07-04T09:00:00+02:00' },
						end: { dateTime: '2026-07-04T10:00:00+02:00' },
						attendees: [
							{ email: 'magnus@example.com', responseStatus: 'accepted' },
							{ email: 'sebastian@example.com', responseStatus: 'needsAction' },
						],
						htmlLink: 'https://calendar.google.com/event?eid=evt-1',
					},
					{
						id: 'evt-2',
						summary: 'All-hands',
						start: { date: '2026-07-05' },
						end: { date: '2026-07-06' },
					},
				],
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('GETs events.list against `primary` by default with singleEvents=true ordered by startTime (AC-U2)', async () => {
		const out = await listCalendarEvents(ACCESS_TOKEN, {
			timeMin: '2026-07-04T00:00:00Z',
			timeMax: '2026-07-06T00:00:00Z',
		})

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		const parsed = new URL(url)
		expect(parsed.pathname).toBe('/calendar/v3/calendars/primary/events')
		expect(parsed.searchParams.get('timeMin')).toBe('2026-07-04T00:00:00Z')
		expect(parsed.searchParams.get('timeMax')).toBe('2026-07-06T00:00:00Z')
		expect(parsed.searchParams.get('singleEvents')).toBe('true')
		expect(parsed.searchParams.get('orderBy')).toBe('startTime')
		expect(parsed.searchParams.get('maxResults')).toBeNull()
		expect(init.method).toBe('GET')

		expect(out).toEqual([
			{
				id: 'evt-1',
				summary: 'Strategy sync',
				description: 'Quarterly bet review',
				start: '2026-07-04T09:00:00+02:00',
				end: '2026-07-04T10:00:00+02:00',
				attendees: [
					{ email: 'magnus@example.com', responseStatus: 'accepted' },
					{ email: 'sebastian@example.com', responseStatus: 'needsAction' },
				],
				htmlLink: 'https://calendar.google.com/event?eid=evt-1',
			},
			{
				id: 'evt-2',
				summary: 'All-hands',
				description: null,
				start: '2026-07-05',
				end: '2026-07-06',
				attendees: [],
				htmlLink: null,
			},
		])
	})

	it('honours an explicit calendarId and maxResults', async () => {
		await listCalendarEvents(ACCESS_TOKEN, {
			calendarId: 'team-shared@group.calendar.google.com',
			timeMin: '2026-07-04T00:00:00Z',
			timeMax: '2026-07-06T00:00:00Z',
			maxResults: 50,
		})
		const [url] = fetchMock.mock.calls[0] as [string]
		const parsed = new URL(url)
		expect(parsed.pathname).toBe(
			'/calendar/v3/calendars/team-shared%40group.calendar.google.com/events',
		)
		expect(parsed.searchParams.get('maxResults')).toBe('50')
	})

	it('returns [] when Google sends no items', async () => {
		fetchMock.mockResolvedValueOnce(mockResponse({}))
		const out = await listCalendarEvents(ACCESS_TOKEN, {
			timeMin: '2026-07-04T00:00:00Z',
			timeMax: '2026-07-06T00:00:00Z',
		})
		expect(out).toEqual([])
	})

	it('surfaces Google 401 as AUTH_REVOKED', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 401 } }, { ok: false, status: 401 }),
		)
		await expect(
			listCalendarEvents(ACCESS_TOKEN, {
				timeMin: '2026-07-04T00:00:00Z',
				timeMax: '2026-07-06T00:00:00Z',
			}),
		).rejects.toBeInstanceOf(GoogleCalendarError)
	})
})

describe('getFreeBusy', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue(
			mockResponse({
				calendars: {
					primary: {
						busy: [
							{ start: '2026-07-04T09:00:00Z', end: '2026-07-04T10:00:00Z' },
							{ start: '2026-07-04T14:00:00Z', end: '2026-07-04T15:00:00Z' },
						],
					},
					'team-shared@group.calendar.google.com': {
						busy: [{ start: '2026-07-04T11:00:00Z', end: '2026-07-04T12:00:00Z' }],
					},
				},
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('POSTs freebusy.query and projects intervals preserving the input order (AC-U3)', async () => {
		const out = await getFreeBusy(ACCESS_TOKEN, {
			calendarIds: ['primary', 'team-shared@group.calendar.google.com'],
			timeMin: '2026-07-04T00:00:00Z',
			timeMax: '2026-07-04T23:59:59Z',
		})

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy')
		expect(init.method).toBe('POST')
		const body = JSON.parse(init.body as string)
		expect(body).toEqual({
			timeMin: '2026-07-04T00:00:00Z',
			timeMax: '2026-07-04T23:59:59Z',
			items: [{ id: 'primary' }, { id: 'team-shared@group.calendar.google.com' }],
		})

		expect(out).toEqual([
			{
				calendarId: 'primary',
				busy: [
					{ start: '2026-07-04T09:00:00Z', end: '2026-07-04T10:00:00Z' },
					{ start: '2026-07-04T14:00:00Z', end: '2026-07-04T15:00:00Z' },
				],
			},
			{
				calendarId: 'team-shared@group.calendar.google.com',
				busy: [{ start: '2026-07-04T11:00:00Z', end: '2026-07-04T12:00:00Z' }],
			},
		])
	})

	it('returns an empty busy list for calendars Google did not include in its response', async () => {
		fetchMock.mockResolvedValueOnce(mockResponse({ calendars: {} }))
		const out = await getFreeBusy(ACCESS_TOKEN, {
			calendarIds: ['primary'],
			timeMin: '2026-07-04T00:00:00Z',
			timeMax: '2026-07-04T23:59:59Z',
		})
		expect(out).toEqual([{ calendarId: 'primary', busy: [] }])
	})

	it('maps Google 401 to AUTH_REVOKED', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 401 } }, { ok: false, status: 401 }),
		)
		await expect(
			getFreeBusy(ACCESS_TOKEN, {
				calendarIds: ['primary'],
				timeMin: '2026-07-04T00:00:00Z',
				timeMax: '2026-07-04T23:59:59Z',
			}),
		).rejects.toMatchObject({ code: ApiErrorCode.AUTH_REVOKED })
	})
})
