import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const { fetchUpcomingMeetings, extractVideoLink } = await import('../services/calendar.js')

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

describe('extractVideoLink', () => {
	it('extracts Google Meet link', () => {
		expect(extractVideoLink('Join at https://meet.google.com/abc-defg-hij')).toBe(
			'https://meet.google.com/abc-defg-hij',
		)
	})

	it('extracts Zoom link', () => {
		expect(extractVideoLink('Zoom: https://zoom.us/j/1234567890?pwd=abc')).toBe(
			'https://zoom.us/j/1234567890?pwd=abc',
		)
	})

	it('extracts Teams link', () => {
		const url = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc'
		expect(extractVideoLink(`Join: ${url}`)).toBe(url)
	})

	it('extracts Webex link', () => {
		expect(extractVideoLink('https://company.webex.com/meet/john.doe')).toBe(
			'https://company.webex.com/meet/john.doe',
		)
	})

	it('returns null when no video link found', () => {
		expect(extractVideoLink('No meeting link here')).toBeNull()
	})

	it('returns null for empty string', () => {
		expect(extractVideoLink('')).toBeNull()
	})
})

describe('fetchUpcomingMeetings', () => {
	beforeEach(() => {
		mockFetch.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('Google Calendar', () => {
		it('normalizes events with conferenceData', async () => {
			mockFetch.mockResolvedValueOnce(
				jsonResponse({
					items: [
						{
							id: 'g-1',
							summary: 'Team Standup',
							start: { dateTime: '2026-03-28T10:00:00Z' },
							end: { dateTime: '2026-03-28T10:30:00Z' },
							conferenceData: {
								entryPoints: [
									{ entryPointType: 'video', uri: 'https://meet.google.com/abc-def-ghi' },
								],
							},
							attendees: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
							organizer: { email: 'alice@example.com' },
						},
					],
				}),
			)

			const events = await fetchUpcomingMeetings('token', 'google-calendar')

			expect(events).toHaveLength(1)
			expect(events[0]).toEqual({
				id: 'g-1',
				title: 'Team Standup',
				start: '2026-03-28T10:00:00Z',
				end: '2026-03-28T10:30:00Z',
				videoLink: 'https://meet.google.com/abc-def-ghi',
				attendees: ['alice@example.com', 'bob@example.com'],
				organizer: 'alice@example.com',
			})
		})

		it('falls back to hangoutLink', async () => {
			mockFetch.mockResolvedValueOnce(
				jsonResponse({
					items: [
						{
							id: 'g-2',
							summary: 'Quick Chat',
							start: { dateTime: '2026-03-28T11:00:00Z' },
							end: { dateTime: '2026-03-28T11:15:00Z' },
							hangoutLink: 'https://meet.google.com/xyz-abc-def',
							organizer: { email: 'me@example.com' },
						},
					],
				}),
			)

			const events = await fetchUpcomingMeetings('token', 'google-calendar')
			expect(events).toHaveLength(1)
			expect(events[0]?.videoLink).toBe('https://meet.google.com/xyz-abc-def')
		})

		it('returns null videoLink when no conference data', async () => {
			mockFetch.mockResolvedValueOnce(
				jsonResponse({
					items: [
						{
							id: 'g-3',
							summary: 'Lunch',
							start: { dateTime: '2026-03-28T12:00:00Z' },
							end: { dateTime: '2026-03-28T13:00:00Z' },
							organizer: { email: 'me@example.com' },
						},
					],
				}),
			)

			const events = await fetchUpcomingMeetings('token', 'google-calendar')
			expect(events).toHaveLength(1)
			expect(events[0]?.videoLink).toBeNull()
		})

		it('throws on API error', async () => {
			mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))

			await expect(fetchUpcomingMeetings('bad-token', 'google-calendar')).rejects.toThrow(
				'Google Calendar API error: 401',
			)
		})
	})

	describe('Outlook Calendar', () => {
		it('normalizes events with onlineMeeting', async () => {
			mockFetch.mockResolvedValueOnce(
				jsonResponse({
					value: [
						{
							id: 'o-1',
							subject: 'Sprint Review',
							start: { dateTime: '2026-03-28T14:00:00' },
							end: { dateTime: '2026-03-28T15:00:00' },
							onlineMeeting: {
								joinUrl: 'https://teams.microsoft.com/l/meetup-join/meeting123',
							},
							attendees: [
								{ emailAddress: { address: 'charlie@example.com' } },
								{ emailAddress: { address: 'diana@example.com' } },
							],
							organizer: { emailAddress: { address: 'charlie@example.com' } },
						},
					],
				}),
			)

			const events = await fetchUpcomingMeetings('token', 'outlook-calendar')

			expect(events).toHaveLength(1)
			expect(events[0]).toEqual({
				id: 'o-1',
				title: 'Sprint Review',
				start: '2026-03-28T14:00:00',
				end: '2026-03-28T15:00:00',
				videoLink: 'https://teams.microsoft.com/l/meetup-join/meeting123',
				attendees: ['charlie@example.com', 'diana@example.com'],
				organizer: 'charlie@example.com',
			})
		})

		it('extracts video link from body content when no onlineMeeting', async () => {
			mockFetch.mockResolvedValueOnce(
				jsonResponse({
					value: [
						{
							id: 'o-2',
							subject: 'Zoom Call',
							start: { dateTime: '2026-03-28T16:00:00' },
							end: { dateTime: '2026-03-28T17:00:00' },
							body: { content: 'Join: https://zoom.us/j/9876543210' },
							organizer: { emailAddress: { address: 'eve@example.com' } },
						},
					],
				}),
			)

			const events = await fetchUpcomingMeetings('token', 'outlook-calendar')
			expect(events).toHaveLength(1)
			expect(events[0]?.videoLink).toBe('https://zoom.us/j/9876543210')
		})

		it('returns null videoLink when no meeting info', async () => {
			mockFetch.mockResolvedValueOnce(
				jsonResponse({
					value: [
						{
							id: 'o-3',
							subject: 'Coffee',
							start: { dateTime: '2026-03-28T09:00:00' },
							end: { dateTime: '2026-03-28T09:30:00' },
							organizer: { emailAddress: { address: 'frank@example.com' } },
						},
					],
				}),
			)

			const events = await fetchUpcomingMeetings('token', 'outlook-calendar')
			expect(events).toHaveLength(1)
			expect(events[0]?.videoLink).toBeNull()
		})

		it('throws on API error', async () => {
			mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))

			await expect(fetchUpcomingMeetings('bad-token', 'outlook-calendar')).rejects.toThrow(
				'Outlook Calendar API error: 403',
			)
		})
	})
})
