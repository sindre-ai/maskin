import type { IntegrationCredentials, IntegrationProvider } from './types'

/** A calendar event normalized from any calendar provider */
export interface CalendarEvent {
	/** Provider's event ID */
	externalId: string
	/** iCal UID for cross-provider deduplication */
	iCalUid?: string
	/** Event title */
	title: string
	/** Event description/body */
	description?: string
	/** Start time (ISO 8601) */
	startTime: string
	/** End time (ISO 8601) */
	endTime: string
	/** IANA timezone */
	timezone?: string
	/** Conference/meeting join URL (Zoom, Meet, Teams link) */
	meetingUrl?: string
	/** Meeting platform detected from URL */
	meetingPlatform?: 'google_meet' | 'zoom' | 'teams' | 'webex' | 'other'
	/** Organizer email */
	organizerEmail?: string
	/** Attendees */
	attendees: Array<{
		email: string
		name?: string
		responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needs_action'
	}>
	/** Whether this is a recurring event */
	isRecurring: boolean
	/** Recurrence ID (for recurring event instances) */
	recurrenceId?: string
	/** Raw provider event for debugging */
	raw: unknown
}

/** Result of a calendar sync operation */
export interface CalendarSyncResult {
	/** New events found */
	created: CalendarEvent[]
	/** Events that were updated */
	updated: CalendarEvent[]
	/** External IDs of events that were deleted */
	deleted: string[]
	/** Sync token for incremental sync (provider-specific) */
	syncToken?: string
}

/**
 * Calendar provider interface — extends IntegrationProvider with calendar-specific methods.
 * Calendar providers are core integrations, not module-specific.
 */
export interface CalendarProvider extends IntegrationProvider {
	/** Perform a full or incremental sync of calendar events */
	syncEvents(
		credentials: IntegrationCredentials,
		options?: {
			/** Sync token for incremental sync */
			syncToken?: string
			/** Only fetch events after this time (ISO 8601) */
			timeMin?: string
			/** Only fetch events before this time (ISO 8601) */
			timeMax?: string
		},
	): Promise<CalendarSyncResult>

	/** Set up push notifications / webhooks for calendar changes */
	subscribeToChanges(
		credentials: IntegrationCredentials,
		webhookUrl: string,
	): Promise<{ subscriptionId: string; expiresAt: string }>

	/** Renew an expiring webhook subscription */
	renewSubscription(
		credentials: IntegrationCredentials,
		subscriptionId: string,
	): Promise<{ expiresAt: string }>

	/** Parse an incoming calendar webhook into actionable data */
	parseCalendarWebhook(
		payload: unknown,
		headers: Record<string, string>,
	): { changedEventIds?: string[]; requiresResync: boolean }
}
