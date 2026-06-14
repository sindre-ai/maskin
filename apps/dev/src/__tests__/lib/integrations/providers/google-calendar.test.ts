import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../../../lib/integrations/providers/google-calendar/config'
import { resolveExternalId } from '../../../../lib/integrations/providers/google-calendar/resolve-id'
import { calendarEventToMeetingFields } from '../../../../lib/integrations/providers/google-calendar/watch'
import {
	buildChannelToken,
	googleCalendarEventNormalizer,
	googleCalendarWebhookVerifier,
} from '../../../../lib/integrations/providers/google-calendar/webhooks'

describe('Google Calendar provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('google-calendar')
		expect(config.displayName).toBe('Google Calendar')
	})

	it('uses standard oauth2 with PKCE and offline access', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://accounts.google.com/o/oauth2/v2/auth',
			)
			expect(config.auth.config.tokenUrl).toBe('https://oauth2.googleapis.com/token')
			expect(config.auth.config.revokeUrl).toBe('https://oauth2.googleapis.com/revoke')
			expect(config.auth.config.clientIdEnv).toBe('GOOGLE_CALENDAR_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('GOOGLE_CALENDAR_CLIENT_SECRET')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toContain(
				'https://www.googleapis.com/auth/calendar.events.readonly',
			)
			expect(config.auth.config.scopes).toContain('https://www.googleapis.com/auth/userinfo.email')
			expect(config.auth.config.extraAuthParams).toMatchObject({
				access_type: 'offline',
				prompt: 'consent',
			})
		}
	})

	it('uses custom webhook type for channel push notifications', () => {
		expect(config.webhook).toEqual({ type: 'custom' })
	})

	it('defines google-calendar.event events with created/updated/cancelled actions', () => {
		const def = config.events?.definitions.find((d) => d.entityType === 'google-calendar.event')
		expect(def?.actions).toEqual(expect.arrayContaining(['created', 'updated', 'cancelled']))
	})

	it('does not configure an MCP server (calendar is server-side only)', () => {
		expect(config.mcp).toBeUndefined()
	})
})

describe('resolveExternalId', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns email from Google userinfo', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ email: 'magnus@example.com' }),
		} as Response)

		const id = await resolveExternalId({ accessToken: 'ya29.a0test' })
		expect(id).toBe('magnus@example.com')
		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://www.googleapis.com/oauth2/v2/userinfo',
			expect.objectContaining({
				headers: { Authorization: 'Bearer ya29.a0test' },
			}),
		)
	})

	it('throws when userinfo response is missing email', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'tok' })).rejects.toThrow(
			'Google userinfo response missing email',
		)
	})

	it('throws on HTTP error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: () => Promise.resolve('unauthorized'),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'expired' })).rejects.toThrow(
			'Failed to resolve Google Calendar email: HTTP 401',
		)
	})
})

describe('googleCalendarWebhookVerifier', () => {
	const ORIGINAL_SECRET = process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET
	const SECRET = 'test-webhook-secret-32-chars-long-abc'

	beforeEach(() => {
		process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET = SECRET
	})

	afterEach(() => {
		process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET = ORIGINAL_SECRET
	})

	it('accepts a push whose token HMAC matches', () => {
		const token = buildChannelToken('magnus@example.com', SECRET)
		expect(googleCalendarWebhookVerifier('', { 'x-goog-channel-token': token })).toBe(true)
	})

	it('rejects a push with no channel token', () => {
		expect(googleCalendarWebhookVerifier('', {})).toBe(false)
	})

	it('rejects a push with a tampered token', () => {
		const valid = buildChannelToken('magnus@example.com', SECRET)
		const forged = valid.replace('magnus', 'attacker')
		expect(googleCalendarWebhookVerifier('', { 'x-goog-channel-token': forged })).toBe(false)
	})

	it('rejects a push signed with a different secret', () => {
		const otherSecret = createHmac('sha256', 'wrong-secret').update('x').digest('hex')
		const forged = buildChannelToken('magnus@example.com', otherSecret)
		expect(googleCalendarWebhookVerifier('', { 'x-goog-channel-token': forged })).toBe(false)
	})

	it('rejects a push when GOOGLE_CALENDAR_WEBHOOK_SECRET is unconfigured', () => {
		process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET = ''
		const token = buildChannelToken('magnus@example.com', SECRET)
		expect(googleCalendarWebhookVerifier('', { 'x-goog-channel-token': token })).toBe(false)
	})

	it('rejects a malformed token (no separator)', () => {
		expect(googleCalendarWebhookVerifier('', { 'x-goog-channel-token': 'no-separator-here' })).toBe(
			false,
		)
	})
})

describe('googleCalendarEventNormalizer', () => {
	const SECRET = 'test-secret-32-chars-aaaaaaaaaaaa'
	const ORIGINAL_SECRET = process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET

	beforeEach(() => {
		process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET = SECRET
	})

	afterEach(() => {
		process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET = ORIGINAL_SECRET
	})

	const headersFor = (extra: Record<string, string>): Record<string, string> => ({
		'x-goog-channel-id': 'channel-uuid-1',
		'x-goog-resource-id': 'resource-1',
		'x-goog-channel-token': buildChannelToken('magnus@example.com', SECRET),
		'x-goog-resource-state': 'exists',
		...extra,
	})

	it('emits a channel.notified event for non-sync pushes', () => {
		const result = googleCalendarEventNormalizer(null, headersFor({}))
		expect(result).toEqual({
			entityType: 'google-calendar.channel',
			action: 'notified',
			installationId: 'magnus@example.com',
			data: {
				channelId: 'channel-uuid-1',
				resourceId: 'resource-1',
				resourceState: 'exists',
			},
		})
	})

	it('returns null on the initial sync handshake', () => {
		const result = googleCalendarEventNormalizer(
			null,
			headersFor({ 'x-goog-resource-state': 'sync' }),
		)
		expect(result).toBeNull()
	})

	it('returns null when a required X-Goog header is missing', () => {
		const headers = headersFor({})
		const { 'x-goog-resource-id': _omit, ...withoutResourceId } = headers
		expect(googleCalendarEventNormalizer(null, withoutResourceId)).toBeNull()
	})

	it('returns null when the channel token fails verification', () => {
		const headers = headersFor({ 'x-goog-channel-token': 'bogus:0000' })
		expect(googleCalendarEventNormalizer(null, headers)).toBeNull()
	})
})

describe('calendarEventToMeetingFields', () => {
	it('extracts the video conference URI in preference to hangoutLink', () => {
		const out = calendarEventToMeetingFields(
			{
				id: 'evt-1',
				status: 'confirmed',
				summary: 'Sync',
				start: { dateTime: '2026-06-14T10:00:00Z' },
				end: { dateTime: '2026-06-14T10:30:00Z' },
				hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc',
				conferenceData: {
					entryPoints: [
						{ entryPointType: 'video', uri: 'https://meet.google.com/xxx-yyyy-zzz' },
						{ entryPointType: 'phone', uri: 'tel:+18005551234' },
					],
				},
				attendees: [
					{ email: 'a@example.com', displayName: 'Alice', responseStatus: 'accepted' },
					{ email: 'b@example.com' },
				],
			},
			false,
		)
		expect(out.calendarProvider).toBe('google')
		expect(out.calendarEventId).toBe('evt-1')
		expect(out.meetingUrl).toBe('https://meet.google.com/xxx-yyyy-zzz')
		expect(out.startTime).toBe('2026-06-14T10:00:00Z')
		expect(out.endTime).toBe('2026-06-14T10:30:00Z')
		expect(out.attendees).toEqual([
			{ email: 'a@example.com', name: 'Alice', responseStatus: 'accepted' },
			{ email: 'b@example.com', name: undefined, responseStatus: undefined },
		])
		expect(out.cancelled).toBe(false)
	})

	it('falls back to hangoutLink when no video entry point is present', () => {
		const out = calendarEventToMeetingFields(
			{
				id: 'evt-2',
				hangoutLink: 'https://meet.google.com/legacy',
				start: { dateTime: '2026-06-14T10:00:00Z' },
				end: { dateTime: '2026-06-14T10:30:00Z' },
			},
			false,
		)
		expect(out.meetingUrl).toBe('https://meet.google.com/legacy')
	})

	it('returns null meetingUrl for phone-only / in-person events', () => {
		const out = calendarEventToMeetingFields(
			{
				id: 'evt-3',
				start: { dateTime: '2026-06-14T10:00:00Z' },
				end: { dateTime: '2026-06-14T10:30:00Z' },
			},
			true,
		)
		expect(out.meetingUrl).toBeNull()
	})

	it('marks cancelled status when event.status === cancelled', () => {
		const out = calendarEventToMeetingFields({ id: 'evt-4', status: 'cancelled' }, true)
		expect(out.cancelled).toBe(true)
		// Cancelled events should never get skjaldJoin=true even if autoJoin default is on.
		expect(out.skjaldJoin).toBe(false)
	})

	it('only sets skjaldJoin=true when workspace autoJoin=true AND meeting has a video URL', () => {
		const withUrl = calendarEventToMeetingFields(
			{
				id: 'a',
				hangoutLink: 'https://meet.google.com/aaa',
				start: { dateTime: '2026-06-14T10:00:00Z' },
				end: { dateTime: '2026-06-14T10:30:00Z' },
			},
			true,
		)
		expect(withUrl.skjaldJoin).toBe(true)
		expect(withUrl.autoJoin).toBe(true)

		const withoutUrl = calendarEventToMeetingFields(
			{
				id: 'b',
				start: { dateTime: '2026-06-14T10:00:00Z' },
				end: { dateTime: '2026-06-14T10:30:00Z' },
			},
			true,
		)
		expect(withoutUrl.skjaldJoin).toBe(false)
	})

	it('defaults skjaldJoin to false when workspace autoJoin=false', () => {
		const out = calendarEventToMeetingFields(
			{
				id: 'c',
				hangoutLink: 'https://meet.google.com/ccc',
				start: { dateTime: '2026-06-14T10:00:00Z' },
				end: { dateTime: '2026-06-14T10:30:00Z' },
			},
			false,
		)
		expect(out.skjaldJoin).toBe(false)
		expect(out.autoJoin).toBe(false)
	})
})
