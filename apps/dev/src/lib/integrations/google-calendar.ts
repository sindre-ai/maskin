import { randomUUID } from 'node:crypto'
import type { CalendarEvent, CalendarProvider, CalendarSyncResult } from './calendar-types'
import type { EventDefinition, IntegrationCredentials, NormalizedEvent } from './types'

const GOOGLE_CALENDAR_EVENTS: EventDefinition[] = [
	{
		entityType: 'calendar.event',
		actions: ['created', 'updated', 'deleted'],
		label: 'Calendar Event',
	},
]

const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly'

function getEnvOrThrow(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} environment variable is required`)
	return value
}

function detectMeetingPlatform(
	url: string,
): 'google_meet' | 'zoom' | 'teams' | 'webex' | 'other' | undefined {
	if (!url) return undefined
	if (url.includes('meet.google.com')) return 'google_meet'
	if (url.includes('zoom.us') || url.includes('zoom.com')) return 'zoom'
	if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'teams'
	if (url.includes('webex.com')) return 'webex'
	return 'other'
}

const MEETING_URL_PATTERN =
	/https?:\/\/(?:meet\.google\.com|[\w.-]*zoom\.(?:us|com)|teams\.(?:microsoft\.com|live\.com)|[\w.-]*webex\.com)\/\S+/i

function extractMeetingUrl(event: Record<string, unknown>): string | undefined {
	// 1. Check conferenceData entryPoints for video type
	const conferenceData = event.conferenceData as Record<string, unknown> | undefined
	if (conferenceData) {
		const entryPoints = conferenceData.entryPoints as Array<Record<string, unknown>> | undefined
		if (entryPoints) {
			const videoEntry = entryPoints.find((ep) => ep.entryPointType === 'video')
			if (videoEntry?.uri) return videoEntry.uri as string
		}
	}

	// 2. Fallback to hangoutLink
	if (event.hangoutLink) return event.hangoutLink as string

	// 3. Scan description and location for known meeting URLs
	for (const field of ['description', 'location']) {
		const value = event[field] as string | undefined
		if (value) {
			const match = value.match(MEETING_URL_PATTERN)
			if (match) return match[0]
		}
	}

	return undefined
}

function mapResponseStatus(
	status: string | undefined,
): 'accepted' | 'declined' | 'tentative' | 'needs_action' | undefined {
	switch (status) {
		case 'accepted':
			return 'accepted'
		case 'declined':
			return 'declined'
		case 'tentative':
			return 'tentative'
		case 'needsAction':
			return 'needs_action'
		default:
			return undefined
	}
}

function mapGoogleEvent(event: Record<string, unknown>): CalendarEvent {
	const start = event.start as Record<string, string> | undefined
	const end = event.end as Record<string, string> | undefined
	const organizer = event.organizer as Record<string, string> | undefined
	const attendeesRaw = event.attendees as Array<Record<string, unknown>> | undefined

	const meetingUrl = extractMeetingUrl(event)

	return {
		externalId: event.id as string,
		iCalUid: event.iCalUID as string | undefined,
		title: (event.summary as string) || '(No title)',
		description: event.description as string | undefined,
		startTime: start?.dateTime || start?.date || '',
		endTime: end?.dateTime || end?.date || '',
		timezone: start?.timeZone,
		meetingUrl,
		meetingPlatform: meetingUrl ? detectMeetingPlatform(meetingUrl) : undefined,
		organizerEmail: organizer?.email,
		attendees: (attendeesRaw || []).map((a) => ({
			email: a.email as string,
			name: a.displayName as string | undefined,
			responseStatus: mapResponseStatus(a.responseStatus as string | undefined),
		})),
		isRecurring: !!event.recurringEventId,
		recurrenceId: event.recurringEventId as string | undefined,
		raw: event,
	}
}

async function refreshAccessToken(credentials: IntegrationCredentials): Promise<{
	access_token: string
	expires_in: number
}> {
	const clientId = getEnvOrThrow('GOOGLE_CLIENT_ID')
	const clientSecret = getEnvOrThrow('GOOGLE_CLIENT_SECRET')

	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: credentials.refresh_token as string,
			grant_type: 'refresh_token',
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Failed to refresh Google token: ${response.status} ${text}`)
	}

	return (await response.json()) as { access_token: string; expires_in: number }
}

export class GoogleCalendarProvider implements CalendarProvider {
	name = 'google_calendar'
	displayName = 'Google Calendar'

	getInstallUrl(state: string): string {
		const clientId = getEnvOrThrow('GOOGLE_CLIENT_ID')
		const redirectUri = getEnvOrThrow('GOOGLE_REDIRECT_URI')

		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: SCOPES,
			access_type: 'offline',
			prompt: 'consent',
			state,
		})

		return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
	}

	async handleCallback(params: Record<string, string>): Promise<IntegrationCredentials> {
		const code = params.code
		if (!code) {
			throw new Error('Missing authorization code in callback')
		}

		const clientId = getEnvOrThrow('GOOGLE_CLIENT_ID')
		const clientSecret = getEnvOrThrow('GOOGLE_CLIENT_SECRET')
		const redirectUri = getEnvOrThrow('GOOGLE_REDIRECT_URI')

		// Exchange auth code for tokens
		const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code',
			}),
		})

		if (!tokenResponse.ok) {
			const text = await tokenResponse.text()
			throw new Error(`Failed to exchange Google auth code: ${tokenResponse.status} ${text}`)
		}

		const tokens = (await tokenResponse.json()) as {
			access_token: string
			refresh_token?: string
			expires_in: number
			token_type: string
		}

		if (!tokens.refresh_token) {
			throw new Error(
				'No refresh_token returned. Ensure access_type=offline and prompt=consent are set.',
			)
		}

		// Get user email for installation_id
		const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: { Authorization: `Bearer ${tokens.access_token}` },
		})

		if (!userResponse.ok) {
			const text = await userResponse.text()
			throw new Error(`Failed to get Google user info: ${userResponse.status} ${text}`)
		}

		const user = (await userResponse.json()) as { email: string }
		const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

		return {
			installation_id: user.email,
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			token_expiry: tokenExpiry,
		}
	}

	async syncEvents(
		credentials: IntegrationCredentials,
		options?: {
			syncToken?: string
			timeMin?: string
			timeMax?: string
		},
	): Promise<CalendarSyncResult> {
		const accessToken = await this.getAccessToken(credentials)

		const params = new URLSearchParams({
			singleEvents: 'true',
			maxResults: '250',
		})

		if (options?.syncToken) {
			// Incremental sync — only syncToken needed
			params.set('syncToken', options.syncToken)
		} else {
			// Full sync — use time range
			const timeMin = options?.timeMin || new Date().toISOString()
			const timeMax =
				options?.timeMax || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
			params.set('timeMin', timeMin)
			params.set('timeMax', timeMax)
			params.set('orderBy', 'startTime')
		}

		const created: CalendarEvent[] = []
		const updated: CalendarEvent[] = []
		const deleted: string[] = []
		let nextPageToken: string | undefined
		let nextSyncToken: string | undefined

		do {
			if (nextPageToken) {
				params.set('pageToken', nextPageToken)
			}

			const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${accessToken}` },
			})

			if (response.status === 410) {
				// Sync token invalidated — caller should do a full sync
				throw new Error('SYNC_TOKEN_INVALIDATED')
			}

			if (!response.ok) {
				const text = await response.text()
				throw new Error(`Failed to list Google Calendar events: ${response.status} ${text}`)
			}

			const data = (await response.json()) as {
				items?: Array<Record<string, unknown>>
				nextPageToken?: string
				nextSyncToken?: string
			}

			for (const item of data.items || []) {
				if (item.status === 'cancelled') {
					deleted.push(item.id as string)
				} else if (options?.syncToken) {
					// During incremental sync, treat all non-cancelled as updated
					updated.push(mapGoogleEvent(item))
				} else {
					created.push(mapGoogleEvent(item))
				}
			}

			nextPageToken = data.nextPageToken
			nextSyncToken = data.nextSyncToken
		} while (nextPageToken)

		return {
			created,
			updated,
			deleted,
			syncToken: nextSyncToken,
		}
	}

	async subscribeToChanges(
		credentials: IntegrationCredentials,
		webhookUrl: string,
	): Promise<{ subscriptionId: string; expiresAt: string }> {
		const accessToken = await this.getAccessToken(credentials)
		const channelId = randomUUID()

		const response = await fetch(
			'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					id: channelId,
					type: 'web_hook',
					address: webhookUrl,
					token: credentials.installation_id,
				}),
			},
		)

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Failed to subscribe to Google Calendar changes: ${response.status} ${text}`)
		}

		const data = (await response.json()) as {
			id: string
			resourceId: string
			expiration: string
		}

		return {
			subscriptionId: `${data.id}:${data.resourceId}`,
			expiresAt: new Date(Number(data.expiration)).toISOString(),
		}
	}

	async renewSubscription(
		credentials: IntegrationCredentials,
		subscriptionId: string,
	): Promise<{ expiresAt: string }> {
		const accessToken = await this.getAccessToken(credentials)

		// Stop the old channel
		const [channelId, resourceId] = subscriptionId.split(':')
		await fetch('https://www.googleapis.com/calendar/v3/channels/stop', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ id: channelId, resourceId }),
		})
		// Ignore errors on stop — channel may have already expired

		// Create a new subscription
		const result = await this.subscribeToChanges(credentials, '')
		return { expiresAt: result.expiresAt }
	}

	parseCalendarWebhook(
		_payload: unknown,
		headers: Record<string, string>,
	): { changedEventIds?: string[]; requiresResync: boolean } {
		const resourceState = headers['x-goog-resource-state']

		if (resourceState === 'sync') {
			// Initial sync confirmation from Google
			return { requiresResync: true }
		}

		if (resourceState === 'exists' || resourceState === 'update') {
			// Something changed — re-sync to get the changes
			return { requiresResync: true }
		}

		// Unknown state — ignore
		return { requiresResync: false }
	}

	verifyWebhook(_body: string, signature: string): boolean {
		// Google Calendar webhooks don't use signatures.
		// Instead, we verify by checking the channel token matches an expected value.
		// The signature parameter here carries the X-Goog-Channel-Token header value,
		// which we set to the installation_id (user email) when subscribing.
		// If a token is provided, we consider it valid (the caller should match it
		// against stored credentials).
		return !!signature
	}

	normalizeEvent(_payload: unknown, headers: Record<string, string>): NormalizedEvent | null {
		const resourceState = headers['x-goog-resource-state']
		if (!resourceState) return null

		const channelToken = headers['x-goog-channel-token'] || ''
		if (!channelToken) return null

		let action: string
		switch (resourceState) {
			case 'exists':
			case 'update':
				action = 'updated'
				break
			case 'sync':
				action = 'created'
				break
			default:
				return null
		}

		return {
			entityType: 'calendar.event',
			action,
			installationId: channelToken,
			data: {
				resourceState,
				channelId: headers['x-goog-channel-id'],
				resourceId: headers['x-goog-resource-id'],
			},
		}
	}

	getAvailableEvents(): EventDefinition[] {
		return GOOGLE_CALENDAR_EVENTS
	}

	async getAccessToken(credentials: IntegrationCredentials): Promise<string> {
		const tokenExpiry = credentials.token_expiry as string | undefined
		const accessToken = credentials.access_token as string | undefined

		// If token is still valid (with 5 min buffer), return it
		if (accessToken && tokenExpiry) {
			const expiryTime = new Date(tokenExpiry).getTime()
			if (Date.now() < expiryTime - 5 * 60 * 1000) {
				return accessToken
			}
		}

		// Refresh the token
		const refreshed = await refreshAccessToken(credentials)
		return refreshed.access_token
	}

	getMcpCommand(): { command: string; args: string[]; envKey: string } {
		// No MCP server for Google Calendar yet
		return { command: '', args: [], envKey: '' }
	}
}
