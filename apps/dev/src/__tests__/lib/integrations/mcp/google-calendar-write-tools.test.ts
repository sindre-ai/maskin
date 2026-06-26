import { ApiErrorCode } from '@maskin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	GoogleCalendarError,
	createEvent,
	sendRsvp,
	updateEvent,
} from '../../../../lib/integrations/mcp/google-calendar/write-tools'

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

describe('createEvent', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue(
			mockResponse({
				id: 'event-abc',
				htmlLink: 'https://calendar.google.com/event?eid=event-abc',
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('POSTs events.insert with the named calendarId, summary, and ISO datetimes', async () => {
		const out = await createEvent(ACCESS_TOKEN, {
			calendarId: 'primary',
			title: 'Strategy sync',
			start: '2026-07-04T09:00:00+02:00',
			end: '2026-07-04T10:00:00+02:00',
			attendees: ['magnus@example.com', 'sebastian@example.com'],
			description: 'Quarterly bet review',
			location: 'Online',
		})

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events')
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
		const body = JSON.parse(init.body as string)
		expect(body).toEqual({
			summary: 'Strategy sync',
			start: { dateTime: '2026-07-04T09:00:00+02:00' },
			end: { dateTime: '2026-07-04T10:00:00+02:00' },
			description: 'Quarterly bet review',
			location: 'Online',
			attendees: [{ email: 'magnus@example.com' }, { email: 'sebastian@example.com' }],
		})
		expect(out).toEqual({
			eventId: 'event-abc',
			htmlLink: 'https://calendar.google.com/event?eid=event-abc',
		})
	})

	it('forwards Idempotency-Key as Google requestId query parameter (AC-T7)', async () => {
		await createEvent(
			ACCESS_TOKEN,
			{
				calendarId: 'primary',
				title: 'Booked once',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			},
			'idem-2026-07-04-9am',
		)

		const [url] = fetchMock.mock.calls[0] as [string]
		expect(url).toBe(
			'https://www.googleapis.com/calendar/v3/calendars/primary/events?requestId=idem-2026-07-04-9am',
		)
	})

	it('treats bare YYYY-MM-DD as an all-day event (uses `date`, not `dateTime`)', async () => {
		await createEvent(ACCESS_TOKEN, {
			calendarId: 'primary',
			title: 'All-day',
			start: '2026-07-04',
			end: '2026-07-05',
		})
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
		expect(body.start).toEqual({ date: '2026-07-04' })
		expect(body.end).toEqual({ date: '2026-07-05' })
	})

	it('maps Google 401 → AUTH_REVOKED without leaking the upstream body (AC-T8 sibling)', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse(
				{ error: { code: 401, message: 'Invalid Credentials' } },
				{ ok: false, status: 401 },
			),
		)
		await expect(
			createEvent(ACCESS_TOKEN, {
				calendarId: 'primary',
				title: 'fails',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			}),
		).rejects.toMatchObject({
			code: ApiErrorCode.AUTH_REVOKED,
			httpStatus: 401,
		})
	})

	it('maps Google 403 Forbidden → EVENT_FORBIDDEN (AC-T8)', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 403, message: 'Forbidden' } }, { ok: false, status: 403 }),
		)
		await expect(
			createEvent(ACCESS_TOKEN, {
				calendarId: 'primary',
				title: 'denied',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			}),
		).rejects.toMatchObject({ code: ApiErrorCode.EVENT_FORBIDDEN, httpStatus: 403 })
	})

	it('thrown error does not include the raw Google body text', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse(
				{
					error: {
						code: 403,
						message: 'sensitive upstream detail leaks here',
						errors: [{ reason: 'forbidden', message: 'private bits' }],
					},
				},
				{ ok: false, status: 403 },
			),
		)
		try {
			await createEvent(ACCESS_TOKEN, {
				calendarId: 'primary',
				title: 'denied',
				start: '2026-07-04T09:00:00Z',
				end: '2026-07-04T10:00:00Z',
			})
			throw new Error('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(GoogleCalendarError)
			expect((err as Error).message).not.toContain('sensitive upstream detail leaks here')
			expect((err as Error).message).not.toContain('private bits')
		}
	})
})

describe('updateEvent', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('PATCHes only the named change fields (omitted fields are not sent)', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({
				id: 'event-abc',
				summary: 'New title',
				start: { dateTime: '2026-07-04T09:30:00+02:00' },
				end: { dateTime: '2026-07-04T10:30:00+02:00' },
				updated: '2026-07-04T08:00:00Z',
			}),
		)

		const out = await updateEvent(ACCESS_TOKEN, {
			calendarId: 'primary',
			eventId: 'event-abc',
			changes: {
				title: 'New title',
				start: '2026-07-04T09:30:00+02:00',
				end: '2026-07-04T10:30:00+02:00',
			},
		})

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/event-abc')
		expect(init.method).toBe('PATCH')
		const body = JSON.parse(init.body as string)
		// Only the three changed fields — no description, location, attendees.
		expect(Object.keys(body).sort()).toEqual(['end', 'start', 'summary'])
		expect(out.title).toBe('New title')
		expect(out.updated).toBe('2026-07-04T08:00:00Z')
	})

	it('maps Google 412 Precondition Failed → EVENT_CONFLICT and does NOT mutate (AC-T8)', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 412 } }, { ok: false, status: 412 }),
		)

		await expect(
			updateEvent(ACCESS_TOKEN, {
				calendarId: 'primary',
				eventId: 'event-abc',
				changes: { title: 'Loser write' },
			}),
		).rejects.toMatchObject({ code: ApiErrorCode.EVENT_CONFLICT, httpStatus: 412 })
		// AC-T8: on 412 the call must produce exactly one outbound request and
		// no field mutation — Google atomically rejects the patch so the call
		// count is the assertion that nothing was retried or partially applied.
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('maps Google 404 Not Found → EVENT_GONE', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ error: { code: 404 } }, { ok: false, status: 404 }),
		)
		await expect(
			updateEvent(ACCESS_TOKEN, {
				calendarId: 'primary',
				eventId: 'missing',
				changes: { title: 'no-op' },
			}),
		).rejects.toMatchObject({ code: ApiErrorCode.EVENT_GONE, httpStatus: 404 })
	})
})

describe('sendRsvp', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('fetches the event, replaces the caller-side responseStatus, and PATCHes back', async () => {
		fetchMock
			.mockResolvedValueOnce(
				mockResponse({
					id: 'event-1',
					attendees: [
						{ email: 'magnus@example.com', responseStatus: 'needsAction' },
						{ email: 'sebastian@example.com', responseStatus: 'accepted' },
					],
				}),
			)
			.mockResolvedValueOnce(
				mockResponse({
					id: 'event-1',
					attendees: [
						{ email: 'magnus@example.com', responseStatus: 'accepted' },
						{ email: 'sebastian@example.com', responseStatus: 'accepted' },
					],
				}),
			)

		const out = await sendRsvp(ACCESS_TOKEN, {
			calendarId: 'primary',
			eventId: 'event-1',
			response: 'accepted',
			attendeeEmail: 'magnus@example.com',
		})

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const patchInit = fetchMock.mock.calls[1][1] as RequestInit
		const patchBody = JSON.parse(patchInit.body as string)
		expect(patchBody.attendees).toEqual([
			{ email: 'magnus@example.com', responseStatus: 'accepted' },
			{ email: 'sebastian@example.com', responseStatus: 'accepted' },
		])
		expect(out).toEqual({
			eventId: 'event-1',
			attendeeEmail: 'magnus@example.com',
			response: 'accepted',
		})
	})

	it('returns EVENT_FORBIDDEN when the caller is not on the attendee list', async () => {
		fetchMock.mockResolvedValueOnce(
			mockResponse({ id: 'event-1', attendees: [{ email: 'someone-else@example.com' }] }),
		)

		await expect(
			sendRsvp(ACCESS_TOKEN, {
				calendarId: 'primary',
				eventId: 'event-1',
				response: 'declined',
				attendeeEmail: 'magnus@example.com',
			}),
		).rejects.toMatchObject({ code: ApiErrorCode.EVENT_FORBIDDEN, httpStatus: 403 })
		// Did not attempt the PATCH — only the GET ran.
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('compares attendee emails case-insensitively', async () => {
		fetchMock
			.mockResolvedValueOnce(
				mockResponse({
					id: 'event-1',
					attendees: [{ email: 'Magnus@Example.com', responseStatus: 'needsAction' }],
				}),
			)
			.mockResolvedValueOnce(mockResponse({ id: 'event-1' }))

		await sendRsvp(ACCESS_TOKEN, {
			calendarId: 'primary',
			eventId: 'event-1',
			response: 'tentative',
			attendeeEmail: 'magnus@example.com',
		})

		const patchBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
		expect(patchBody.attendees[0]).toMatchObject({
			email: 'Magnus@Example.com',
			responseStatus: 'tentative',
		})
	})
})

describe('GoogleCalendarError', () => {
	it('carries the ApiErrorCode and HTTP status without exposing raw body', () => {
		const err = new GoogleCalendarError(ApiErrorCode.EVENT_CONFLICT, 412, 'safe message')
		expect(err.code).toBe(ApiErrorCode.EVENT_CONFLICT)
		expect(err.httpStatus).toBe(412)
		expect(err.message).toBe('safe message')
		expect(err.name).toBe('GoogleCalendarError')
	})
})
