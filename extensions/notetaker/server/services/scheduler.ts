import { events, integrations, objects, workspaces } from '@ai-native/db/schema'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { CalendarProvider } from './calendar.js'
import { fetchUpcomingMeetings } from './calendar.js'
import { createBot } from './recall.js'

const CALENDAR_PROVIDERS: CalendarProvider[] = ['google-calendar', 'outlook-calendar']

/**
 * Function to get a valid access token for an integration.
 * Injected by the route handler which has access to TokenManager + decrypt.
 */
export type GetTokenFn = (integrationId: string, provider: string) => Promise<string>

interface CalendarIntegration {
	id: string
	workspaceId: string
	provider: string
	createdBy: string
}

/**
 * Sync calendars for a single workspace: fetch upcoming meetings, deduplicate,
 * create meeting objects, and dispatch Recall bots.
 */
export async function syncCalendarsForWorkspace(
	workspaceId: string,
	calendarIntegrations: CalendarIntegration[],
	getToken: GetTokenFn,
	env: ModuleEnv,
): Promise<{ created: number; skipped: number }> {
	const db = env.db
	let created = 0
	let skipped = 0

	for (const integration of calendarIntegrations) {
		try {
			const accessToken = await getToken(integration.id, integration.provider)
			const meetings = await fetchUpcomingMeetings(
				accessToken,
				integration.provider as CalendarProvider,
				{ lookaheadMinutes: 30 },
			)

			// Filter to meetings with video links
			const withVideo = meetings.filter((m) => m.videoLink)
			if (withVideo.length === 0) continue

			// Deduplicate: check which calendar_event_ids already have meeting objects
			const calendarEventIds = withVideo.map((m) => m.id)
			const existing = await db
				.select({ id: objects.id, metadata: objects.metadata })
				.from(objects)
				.where(
					and(
						eq(objects.workspaceId, workspaceId),
						eq(objects.type, 'meeting'),
						inArray(objects.status, ['scheduled', 'recording', 'transcribing']),
						sql`${objects.metadata}->>'calendar_event_id' = ANY(${calendarEventIds})`,
					),
				)

			const existingEventIds = new Set(
				existing
					.map((o) => (o.metadata as Record<string, unknown>)?.calendar_event_id as string)
					.filter(Boolean),
			)

			for (const meeting of withVideo) {
				if (existingEventIds.has(meeting.id)) {
					skipped++
					continue
				}

				// Create meeting object
				const [meetingObj] = await db
					.insert(objects)
					.values({
						workspaceId,
						type: 'meeting',
						title: meeting.title,
						status: 'scheduled',
						metadata: {
							source: 'calendar',
							calendar_event_id: meeting.id,
							calendar_provider: integration.provider,
							meeting_url: meeting.videoLink,
							start: meeting.start,
							end: meeting.end,
							attendees: meeting.attendees,
							organizer: meeting.organizer,
							bot_enabled: true,
						},
						createdBy: integration.createdBy,
					})
					.returning()

				if (!meetingObj) continue

				// Dispatch Recall bot
				try {
					const bot = await createBot(meeting.videoLink as string, {
						botName: 'Maskin Notetaker',
						joinAt: meeting.start,
					})

					// Update meeting with bot_id
					await db
						.update(objects)
						.set({
							metadata: {
								...(meetingObj.metadata as Record<string, unknown>),
								bot_id: bot.id,
							},
							updatedAt: new Date(),
						})
						.where(eq(objects.id, meetingObj.id))
				} catch (botErr) {
					// Mark as failed if bot dispatch fails
					await db
						.update(objects)
						.set({
							status: 'failed',
							metadata: {
								...(meetingObj.metadata as Record<string, unknown>),
								error: botErr instanceof Error ? botErr.message : 'Bot dispatch failed',
							},
							updatedAt: new Date(),
						})
						.where(eq(objects.id, meetingObj.id))
				}

				// Log event
				await db.insert(events).values({
					workspaceId,
					actorId: integration.createdBy,
					action: 'created',
					entityType: 'meeting',
					entityId: meetingObj.id,
					data: meetingObj,
				})

				created++
			}
		} catch (err) {
			console.error('Calendar sync failed for integration', {
				integrationId: integration.id,
				provider: integration.provider,
				error: err instanceof Error ? err.message : err,
			})
		}
	}

	return { created, skipped }
}

/**
 * Sync all workspaces that have active calendar integrations.
 */
export async function syncAllWorkspaces(
	getToken: GetTokenFn,
	env: ModuleEnv,
): Promise<{ workspaces: number; created: number; skipped: number }> {
	const db = env.db

	// Find all active calendar integrations
	const calendarIntegrations = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			provider: integrations.provider,
			createdBy: integrations.createdBy,
		})
		.from(integrations)
		.where(
			and(inArray(integrations.provider, CALENDAR_PROVIDERS), eq(integrations.status, 'active')),
		)

	if (calendarIntegrations.length === 0) {
		return { workspaces: 0, created: 0, skipped: 0 }
	}

	// Group by workspace
	const byWorkspace = new Map<string, CalendarIntegration[]>()
	for (const integration of calendarIntegrations) {
		const list = byWorkspace.get(integration.workspaceId) ?? []
		list.push(integration)
		byWorkspace.set(integration.workspaceId, list)
	}

	// Filter to workspaces with notetaker module enabled
	const workspaceIds = [...byWorkspace.keys()]
	const enabledWorkspaces = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(
			and(
				inArray(workspaces.id, workspaceIds),
				sql`${workspaces.settings}->'enabled_modules' ? 'notetaker'`,
			),
		)

	const enabledIds = new Set(enabledWorkspaces.map((w) => w.id))

	let totalCreated = 0
	let totalSkipped = 0
	let workspaceCount = 0

	for (const [workspaceId, integrationList] of byWorkspace) {
		if (!enabledIds.has(workspaceId)) continue

		const result = await syncCalendarsForWorkspace(workspaceId, integrationList, getToken, env)
		totalCreated += result.created
		totalSkipped += result.skipped
		workspaceCount++
	}

	return { workspaces: workspaceCount, created: totalCreated, skipped: totalSkipped }
}
