import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { events, integrations, objects, workspaces } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import type {
	NormalizedEvent,
	PostInstallContext,
	PreDisconnectContext,
	StoredCredentials,
	WebhookFanOutContext,
} from '../../types'
import { buildChannelToken } from './webhooks'

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
const PRIMARY_CALENDAR = 'primary'

/** Stored under integrations.config alongside system_actor_id. */
export interface GoogleCalendarIntegrationConfig extends IntegrationConfig {
	googleCalendar?: {
		channelId: string
		resourceId: string
		channelExpiration: number
		syncToken?: string
	}
}

interface WatchResponse {
	id: string
	resourceId: string
	expiration?: string
}

interface ParsedWatchResponse {
	channelId: string
	resourceId: string
	channelExpiration: number
}

interface CalendarEventAttendee {
	email?: string
	displayName?: string
	responseStatus?: string
	self?: boolean
	optional?: boolean
}

interface CalendarEventConferenceEntryPoint {
	entryPointType?: string
	uri?: string
}

interface CalendarEventConferenceData {
	entryPoints?: CalendarEventConferenceEntryPoint[]
}

interface CalendarEvent {
	id: string
	status?: string
	summary?: string
	htmlLink?: string
	hangoutLink?: string
	conferenceData?: CalendarEventConferenceData
	start?: { dateTime?: string; date?: string }
	end?: { dateTime?: string; date?: string }
	attendees?: CalendarEventAttendee[]
}

interface EventsListResponse {
	items?: CalendarEvent[]
	nextPageToken?: string
	nextSyncToken?: string
}

function getWebhookAddress(): string {
	const explicit = process.env.GOOGLE_CALENDAR_WEBHOOK_URL
	if (explicit) return explicit
	const base = process.env.API_BASE_URL
	if (!base) {
		throw new Error(
			'GOOGLE_CALENDAR_WEBHOOK_URL (or API_BASE_URL) env var is required for Google Calendar watch',
		)
	}
	return `${base.replace(/\/$/, '')}/api/webhooks/google-calendar`
}

function getWebhookSecret(): string {
	const secret = process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET
	if (!secret) {
		throw new Error('GOOGLE_CALENDAR_WEBHOOK_SECRET env var is required for Google Calendar watch')
	}
	return secret
}

async function callWatch(
	accessToken: string,
	channelId: string,
	channelToken: string,
	address: string,
): Promise<ParsedWatchResponse> {
	const res = await fetch(
		`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(PRIMARY_CALENDAR)}/events/watch`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				id: channelId,
				type: 'web_hook',
				address,
				token: channelToken,
			}),
		},
	)
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Google Calendar events.watch failed: HTTP ${res.status} ${text}`)
	}
	const raw = (await res.json()) as WatchResponse
	if (!raw.id || !raw.resourceId) {
		throw new Error('Google Calendar events.watch response missing id/resourceId')
	}
	const channelExpiration = Number(raw.expiration ?? 0)
	if (!Number.isFinite(channelExpiration) || channelExpiration <= 0) {
		throw new Error(
			`Google Calendar events.watch returned invalid expiration: ${raw.expiration ?? 'undefined'}`,
		)
	}
	return { channelId: raw.id, resourceId: raw.resourceId, channelExpiration }
}

async function callStop(accessToken: string, channelId: string, resourceId: string): Promise<void> {
	const res = await fetch(`${CALENDAR_API_BASE}/channels/stop`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ id: channelId, resourceId }),
	})
	// 204 = stopped; 404 = channel unknown (already expired or never existed) — both acceptable.
	if (!res.ok && res.status !== 404) {
		const text = await res.text()
		throw new Error(`Google Calendar channels.stop failed: HTTP ${res.status} ${text}`)
	}
}

async function listEventsPage(
	accessToken: string,
	params: { syncToken?: string; pageToken?: string },
): Promise<EventsListResponse | { gone: true }> {
	const url = new URL(
		`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(PRIMARY_CALENDAR)}/events`,
	)
	if (params.syncToken) url.searchParams.set('syncToken', params.syncToken)
	if (params.pageToken) url.searchParams.set('pageToken', params.pageToken)
	url.searchParams.set('singleEvents', 'true')
	url.searchParams.set('maxResults', '250')

	const res = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (res.status === 410) {
		// syncToken invalidated — caller must reset and do a full sync.
		return { gone: true }
	}
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Google Calendar events.list failed: HTTP ${res.status} ${text}`)
	}
	return (await res.json()) as EventsListResponse
}

async function fullSync(
	accessToken: string,
): Promise<{ items: CalendarEvent[]; syncToken?: string }> {
	const items: CalendarEvent[] = []
	let pageToken: string | undefined
	let syncToken: string | undefined
	for (let i = 0; i < 50; i++) {
		const page = await listEventsPage(accessToken, { pageToken })
		if ('gone' in page) return { items: [], syncToken: undefined }
		if (page.items) items.push(...page.items)
		if (page.nextSyncToken) syncToken = page.nextSyncToken
		if (!page.nextPageToken) return { items, syncToken }
		pageToken = page.nextPageToken
	}
	logger.warn('Google Calendar events.list pagination exceeded safety bound during full sync')
	return { items, syncToken }
}

async function incrementalSync(
	accessToken: string,
	syncToken: string,
): Promise<{ items: CalendarEvent[]; syncToken?: string } | { gone: true }> {
	const items: CalendarEvent[] = []
	let pageToken: string | undefined
	let nextSyncToken: string | undefined
	for (let i = 0; i < 50; i++) {
		const page = await listEventsPage(accessToken, { syncToken, pageToken })
		if ('gone' in page) return { gone: true }
		if (page.items) items.push(...page.items)
		if (page.nextSyncToken) nextSyncToken = page.nextSyncToken
		if (!page.nextPageToken) return { items, syncToken: nextSyncToken }
		pageToken = page.nextPageToken
	}
	logger.warn(
		'Google Calendar events.list pagination exceeded safety bound during incremental sync',
	)
	return { items, syncToken: nextSyncToken }
}

/**
 * Initial setup: register a watch channel for the connecting user's primary
 * calendar and persist the channel state. Seeds the syncToken via a full sync
 * so the first push has a baseline to diff from.
 */
export async function setupGoogleCalendarWatch(ctx: PostInstallContext): Promise<void> {
	const db = ctx.db as Database
	const accessToken = ctx.credentials.accessToken
	if (!accessToken) {
		throw new Error('Google Calendar postInstall: no access token in credentials')
	}

	const [row] = await db
		.select({ externalId: integrations.externalId })
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)
	const email = row?.externalId
	if (!email) {
		throw new Error('Google Calendar postInstall: integration row missing externalId (email)')
	}

	const channelId = randomUUID()
	const channelToken = buildChannelToken(email, getWebhookSecret())
	const address = getWebhookAddress()

	const watch = await callWatch(accessToken, channelId, channelToken, address)

	// Seed the syncToken so the first push can do an incremental sync. We discard
	// the initial event payload — `meeting` objects for past events aren't useful
	// (the integration starts fresh at install time).
	const seed = await fullSync(accessToken)

	const subobject = JSON.stringify({
		channelId: watch.channelId,
		resourceId: watch.resourceId,
		channelExpiration: watch.channelExpiration,
		syncToken: seed.syncToken ?? null,
	})
	await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{googleCalendar}', ${subobject}::jsonb, true)`,
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, ctx.integrationId))

	logger.info('Google Calendar watch registered', {
		integrationId: ctx.integrationId,
		channelId: watch.channelId,
		expiresAt: watch.channelExpiration,
		seededEvents: seed.items.length,
	})
}

/**
 * Renew an existing watch by creating a new channel and stopping the old one.
 * Google channels can't be extended in place — every renewal is a fresh channel.
 *
 * Preserves the syncToken across the rotation so we don't re-emit historical
 * events. The old channel is stopped best-effort; if Google has already expired
 * it (404), that's fine.
 */
export async function renewGoogleCalendarWatch(db: Database, integrationId: string): Promise<void> {
	const [integration] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, integrationId))
		.limit(1)
	if (!integration) throw new Error(`Integration ${integrationId} not found`)

	const provider = getProvider(integration.provider)
	const tokenManager = new TokenManager()
	const accessToken = await tokenManager.getValidToken(db, integrationId, provider)

	const existing = (integration.config as GoogleCalendarIntegrationConfig | undefined) ?? {}
	if (!existing.googleCalendar?.channelId) {
		// No channel yet (postInstall failed and we're recovering) — fall back to initial setup.
		await setupGoogleCalendarWatch({
			db,
			integrationId,
			workspaceId: integration.workspaceId,
			credentials: { accessToken } as StoredCredentials,
		})
		return
	}

	const email = integration.externalId
	if (!email) {
		throw new Error(`Google Calendar renewal: integration ${integrationId} missing externalId`)
	}

	const channelId = randomUUID()
	const channelToken = buildChannelToken(email, getWebhookSecret())
	const address = getWebhookAddress()
	const fresh = await callWatch(accessToken, channelId, channelToken, address)

	const subobject = JSON.stringify({
		channelId: fresh.channelId,
		resourceId: fresh.resourceId,
		channelExpiration: fresh.channelExpiration,
		syncToken: existing.googleCalendar.syncToken ?? null,
	})
	await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{googleCalendar}', ${subobject}::jsonb, true)`,
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, integrationId))

	// Best-effort stop on the previous channel — orphan reaper. Logged but not thrown:
	// the new channel is live, so the old one expiring naturally is acceptable.
	try {
		await callStop(
			accessToken,
			existing.googleCalendar.channelId,
			existing.googleCalendar.resourceId,
		)
	} catch (err) {
		logger.warn('Google Calendar previous channel stop failed (orphan will expire naturally)', {
			integrationId,
			oldChannelId: existing.googleCalendar.channelId,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	logger.info('Google Calendar watch renewed', {
		integrationId,
		oldChannelId: existing.googleCalendar.channelId,
		newChannelId: fresh.channelId,
		expiresAt: fresh.channelExpiration,
	})
}

/**
 * Stop the active push channel on disconnect. Wired via `preDisconnect` so
 * Google stops sending pushes immediately rather than letting the channel run
 * to its 7-day expiry. Best-effort — disconnect must succeed regardless.
 */
export async function stopGoogleCalendarWatch(ctx: PreDisconnectContext): Promise<void> {
	const db = ctx.db as Database
	const [integration] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)
	if (!integration) return

	const config = (integration.config as GoogleCalendarIntegrationConfig | undefined) ?? {}
	if (!config.googleCalendar?.channelId) return

	try {
		const provider = getProvider(integration.provider)
		const tokenManager = new TokenManager()
		const accessToken = await tokenManager.getValidToken(db, ctx.integrationId, provider)
		await callStop(accessToken, config.googleCalendar.channelId, config.googleCalendar.resourceId)
		logger.info('Google Calendar watch stopped', {
			integrationId: ctx.integrationId,
			channelId: config.googleCalendar.channelId,
		})
	} catch (err) {
		logger.warn('Google Calendar watch stop failed (continuing with disconnect)', {
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

interface MeetingNormalizationOutput {
	calendarEventId: string
	calendarProvider: 'google'
	meetingUrl: string | null
	startTime: string | null
	endTime: string | null
	attendees: Array<{ email: string; name?: string; responseStatus?: string }>
	skjaldJoin: boolean
	autoJoin: boolean
	cancelled: boolean
}

/**
 * Convert a Calendar API event payload into the `meeting` field shape we persist
 * on `objects.metadata`. Exported for unit-testing without DB round-trips.
 */
export function calendarEventToMeetingFields(
	event: CalendarEvent,
	autoJoinDefault: boolean,
): MeetingNormalizationOutput {
	const cancelled = event.status === 'cancelled'
	const conferenceEntry = event.conferenceData?.entryPoints?.find(
		(e) => e.entryPointType === 'video',
	)
	const meetingUrl = conferenceEntry?.uri ?? event.hangoutLink ?? null
	const attendees = (event.attendees ?? [])
		.filter((a): a is CalendarEventAttendee & { email: string } => !!a.email)
		.map((a) => ({
			email: a.email,
			name: a.displayName,
			responseStatus: a.responseStatus,
		}))
	return {
		calendarEventId: event.id,
		calendarProvider: 'google',
		meetingUrl,
		startTime: event.start?.dateTime ?? null,
		endTime: event.end?.dateTime ?? null,
		attendees,
		// T6 (M2a poller) decides per-meeting whether to actually dispatch — we just
		// stamp the workspace default here. autoJoin mirrors the same default; per-meeting
		// override (O1) is set by the user editing the meeting object.
		skjaldJoin: autoJoinDefault && !cancelled && !!meetingUrl,
		autoJoin: autoJoinDefault,
		cancelled,
	}
}

interface NotetakerWorkspaceSettings {
	notetaker?: { autoJoin?: boolean }
}

async function readAutoJoinDefault(db: Database, workspaceId: string): Promise<boolean> {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	const settings = (row?.settings ?? {}) as NotetakerWorkspaceSettings
	return settings.notetaker?.autoJoin === true
}

/** Postgres SQLSTATE for a unique constraint violation. */
const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		(err as { code?: string }).code === PG_UNIQUE_VIOLATION
	)
}

async function findExistingMeeting(
	db: Database,
	workspaceId: string,
	calendarEventId: string,
): Promise<typeof objects.$inferSelect | undefined> {
	const [existing] = await db
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'meeting'),
				sql`${objects.metadata}->>'calendarEventId' = ${calendarEventId}`,
			),
		)
		.limit(1)
	return existing
}

async function updateExistingMeeting(
	db: Database,
	workspaceId: string,
	systemActorId: string,
	existing: typeof objects.$inferSelect,
	title: string,
	nextMetadata: Record<string, unknown>,
	calendarEventId: string,
): Promise<NormalizedEvent> {
	// Existing meeting — merge fresh fields. Skip metadata replacement of fields
	// the user/Skjald may have written (transcriptUrl, audioUrl, language, botName);
	// only refresh the calendar-sourced ones.
	const existingMeta = (existing.metadata as Record<string, unknown> | null) ?? {}
	const mergedMetadata = { ...existingMeta, ...nextMetadata }
	await db
		.update(objects)
		.set({ title, metadata: mergedMetadata, updatedAt: new Date() })
		.where(eq(objects.id, existing.id))
	await db.insert(events).values({
		workspaceId,
		actorId: systemActorId,
		action: 'updated',
		entityType: 'meeting',
		entityId: existing.id,
		data: { calendarEventId },
	})
	return {
		entityType: 'google-calendar.event',
		action: 'updated',
		installationId: '',
		data: { meetingId: existing.id, calendarEventId },
	}
}

/**
 * Apply one calendar event diff to the workspace's meeting objects:
 * - cancelled events → status='cancelled' if a meeting object exists
 * - new events with a meetingUrl → insert a new `meeting` object
 * - existing events → update the meeting object's metadata + status
 *
 * Match key: `metadata->>'calendarEventId'` on `type='meeting'` in the workspace.
 *
 * Concurrent-push safety: the SELECT-then-INSERT is not atomic. Two pushes
 * with different webhook delivery ids (channel rotation, intermediate-state
 * pushes) can both miss the existing row and race into INSERT. The DB-level
 * partial unique index `objects_meeting_calendar_event_id_uniq` makes the
 * loser surface `23505 unique_violation`, which we catch and convert into a
 * re-SELECT + UPDATE so we end with exactly one meeting row.
 */
export async function upsertMeetingFromEvent(
	db: Database,
	workspaceId: string,
	systemActorId: string,
	autoJoinDefault: boolean,
	event: CalendarEvent,
): Promise<NormalizedEvent | null> {
	const fields = calendarEventToMeetingFields(event, autoJoinDefault)
	const existing = await findExistingMeeting(db, workspaceId, fields.calendarEventId)

	const title = event.summary?.trim() || 'Untitled meeting'

	if (fields.cancelled) {
		if (!existing) {
			// Never saw the original — nothing to mark cancelled.
			return null
		}
		await db
			.update(objects)
			.set({ status: 'cancelled', updatedAt: new Date() })
			.where(eq(objects.id, existing.id))
		await db.insert(events).values({
			workspaceId,
			actorId: systemActorId,
			action: 'updated',
			entityType: 'meeting',
			entityId: existing.id,
			data: { status: 'cancelled', calendarEventId: fields.calendarEventId },
		})
		return {
			entityType: 'google-calendar.event',
			action: 'cancelled',
			installationId: '',
			data: { meetingId: existing.id, calendarEventId: fields.calendarEventId },
		}
	}

	const nextMetadata = {
		meetingUrl: fields.meetingUrl,
		startTime: fields.startTime,
		endTime: fields.endTime,
		calendarProvider: fields.calendarProvider,
		calendarEventId: fields.calendarEventId,
		skjaldJoin: fields.skjaldJoin,
		autoJoin: fields.autoJoin,
		attendees: fields.attendees,
	}

	if (!existing) {
		// New event from the calendar — only create a meeting if there's something to
		// notetake (i.e. a video conference URL). All-day events / phone-only events
		// don't need a meeting object.
		if (!fields.meetingUrl) return null
		try {
			const [created] = await db
				.insert(objects)
				.values({
					workspaceId,
					type: 'meeting',
					title,
					status: 'scheduled',
					metadata: nextMetadata,
					createdBy: systemActorId,
				})
				.returning({ id: objects.id })
			if (!created) return null
			await db.insert(events).values({
				workspaceId,
				actorId: systemActorId,
				action: 'created',
				entityType: 'meeting',
				entityId: created.id,
				data: { calendarEventId: fields.calendarEventId },
			})
			return {
				entityType: 'google-calendar.event',
				action: 'created',
				installationId: '',
				data: { meetingId: created.id, calendarEventId: fields.calendarEventId },
			}
		} catch (err) {
			if (!isUniqueViolation(err)) throw err
			// Concurrent push won the INSERT race. Re-SELECT the winner and
			// fold our diff into it as an UPDATE so neither push is lost.
			logger.info('Google Calendar concurrent upsert detected — falling back to update', {
				workspaceId,
				calendarEventId: fields.calendarEventId,
			})
			const winner = await findExistingMeeting(db, workspaceId, fields.calendarEventId)
			if (!winner) {
				// Read-committed: a unique_violation guarantees a committed
				// row visible to this transaction. If SELECT can't find it,
				// the constraint and the read disagree — surface loudly.
				throw new Error(
					`upsertMeetingFromEvent: 23505 raised but no row visible on re-SELECT for calendarEventId=${fields.calendarEventId}`,
				)
			}
			return updateExistingMeeting(
				db,
				workspaceId,
				systemActorId,
				winner,
				title,
				nextMetadata,
				fields.calendarEventId,
			)
		}
	}

	return updateExistingMeeting(
		db,
		workspaceId,
		systemActorId,
		existing,
		title,
		nextMetadata,
		fields.calendarEventId,
	)
}

/**
 * Expand one Calendar push (a `google-calendar.channel.notified` placeholder)
 * into concrete `google-calendar.event` events and write the resulting meeting
 * objects.
 *
 * Calendar push is pointer-style: the headers tell us "something changed",
 * not what. We call events.list with the stored syncToken to pull the diff,
 * persist the advanced syncToken, and emit one event per change. If the
 * syncToken is 410 GONE we full-sync and reset.
 */
export async function fanOutGoogleCalendarChanges(
	ctx: WebhookFanOutContext,
): Promise<NormalizedEvent[]> {
	const db = ctx.db as Database
	const provider = getProvider('google-calendar')
	const tokenManager = new TokenManager()
	const accessToken = await tokenManager.getValidToken(db, ctx.integrationId, provider)

	const [integration] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)
	if (!integration) return []

	const integrationConfig = (integration.config as GoogleCalendarIntegrationConfig) ?? {}
	const systemActorId = integrationConfig.system_actor_id
	if (!systemActorId) {
		logger.warn('Google Calendar fan-out: integration missing system_actor_id', {
			integrationId: ctx.integrationId,
		})
		return []
	}
	const incomingChannelId = String(ctx.normalized.data.channelId ?? '')
	const storedChannelId = integrationConfig.googleCalendar?.channelId
	if (incomingChannelId && storedChannelId && incomingChannelId !== storedChannelId) {
		// Stale channel — Google delivered a push from a channel we've already rotated
		// past. Drop it silently; the new channel's pushes will carry the same diff.
		logger.info('Google Calendar push from rotated channel — ignoring', {
			integrationId: ctx.integrationId,
			storedChannelId,
			incomingChannelId,
		})
		return []
	}

	const autoJoinDefault = await readAutoJoinDefault(db, integration.workspaceId)
	const syncToken = integrationConfig.googleCalendar?.syncToken

	let diff: { items: CalendarEvent[]; syncToken?: string }
	if (syncToken) {
		const result = await incrementalSync(accessToken, syncToken)
		if ('gone' in result) {
			logger.info('Google Calendar syncToken expired — full-syncing and resetting', {
				integrationId: ctx.integrationId,
			})
			diff = await fullSync(accessToken)
		} else {
			diff = { items: result.items, syncToken: result.syncToken }
		}
	} else {
		// No cursor yet — first push after install. Full-sync and seed cursor; emit
		// no events for the seeded items (they were already in the calendar at install
		// time, the user didn't expect new meeting objects for them).
		const seed = await fullSync(accessToken)
		diff = { items: [], syncToken: seed.syncToken }
	}

	const emitted: NormalizedEvent[] = []
	for (const event of diff.items) {
		const out = await upsertMeetingFromEvent(
			db,
			integration.workspaceId,
			systemActorId,
			autoJoinDefault,
			event,
		)
		if (out) emitted.push(out)
	}

	if (diff.syncToken) {
		await db
			.update(integrations)
			.set({
				config: sql`jsonb_set(
					COALESCE(${integrations.config}, '{}'::jsonb),
					'{googleCalendar,syncToken}',
					to_jsonb(${diff.syncToken}::text),
					true
				)`,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, ctx.integrationId))
	}

	logger.info('Google Calendar fan-out tick', {
		integrationId: ctx.integrationId,
		scanned: diff.items.length,
		emitted: emitted.length,
	})

	return emitted
}
