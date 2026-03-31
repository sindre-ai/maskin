import type { Database } from '@ai-native/db'
import { events, integrations, objects } from '@ai-native/db/schema'
import { createBot, deleteBotFromEvent, scheduleBotForEvent } from '@ai-native/ext-notetaker/recall'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { logger } from '../logger'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MeetingMapEntry {
	recall_event_id?: string
	bot_id?: string
}

export interface IntegrationMeetingConfig {
	system_actor_id?: string
	recall_calendar_id?: string
	meeting_map?: Record<string, MeetingMapEntry>
	bot_map?: Record<string, string>
}

// ── Map helpers ──────────────────────────────────────────────────────────────

export function getMeetingMap(config: IntegrationMeetingConfig): Record<string, MeetingMapEntry> {
	return config.meeting_map ?? {}
}

export function getBotMap(config: IntegrationMeetingConfig): Record<string, string> {
	return config.bot_map ?? {}
}

/** Find object ID by recall_event_id in the meeting_map */
export function findByRecallEventId(
	meetingMap: Record<string, MeetingMapEntry>,
	recallEventId: string,
): string | null {
	for (const [objectId, entry] of Object.entries(meetingMap)) {
		if (entry.recall_event_id === recallEventId) return objectId
	}
	return null
}

/** Remove undefined/null entries from a record */
function compact<T>(record: Record<string, T | undefined | null>): Record<string, T> {
	return Object.fromEntries(Object.entries(record).filter(([, v]) => v != null)) as Record<
		string,
		T
	>
}

/** Save updated maps back to integration config */
export async function saveMaps(
	db: Database,
	integrationId: string,
	config: IntegrationMeetingConfig,
	meetingMap: Record<string, MeetingMapEntry>,
	botMap: Record<string, string>,
) {
	await db
		.update(integrations)
		.set({
			config: {
				...config,
				meeting_map: compact(meetingMap),
				bot_map: compact(botMap),
			},
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, integrationId))
}

// ── Bot scheduling ───────────────────────────────────────────────────────────

/**
 * Schedule or unschedule a bot for a meeting based on send_meeting_bot flag.
 * Updates integration config maps accordingly.
 */
export async function scheduleOrUnscheduleBot(
	db: Database,
	meetingId: string,
	meetingMetadata: Record<string, unknown>,
	shouldSendBot: boolean,
	integrationId: string,
	config: IntegrationMeetingConfig,
	botConfig?: Record<string, unknown>,
): Promise<void> {
	const meetingMap = getMeetingMap(config)
	const botMap = getBotMap(config)
	const entry = meetingMap[meetingId] ?? {}
	const meetingUrl = meetingMetadata.meeting_url as string | undefined

	if (shouldSendBot && meetingUrl && !entry.bot_id) {
		// Schedule bot
		try {
			let botId: string | undefined

			if (entry.recall_event_id) {
				// Calendar-sourced: use Calendar V2 API
				const startTime = meetingMetadata.start as string | undefined
				const deduplicationKey = `${startTime}-${meetingUrl}`
				const updatedEvent = await scheduleBotForEvent(
					entry.recall_event_id,
					deduplicationKey,
					botConfig,
				)
				botId = updatedEvent.bots?.[0]?.id
			} else {
				// Manual meeting: use V1 bot API
				const botName = (botConfig?.bot_name as string) ?? 'Sindre'
				const bot = await createBot(meetingUrl, { botName })
				botId = bot.id
			}

			if (botId) {
				entry.bot_id = botId
				meetingMap[meetingId] = entry
				botMap[botId] = meetingId
				await saveMaps(db, integrationId, config, meetingMap, botMap)
			}
		} catch (err) {
			logger.error('Failed to schedule bot', {
				meetingId,
				error: err instanceof Error ? err.message : String(err),
			})
			// Mark meeting as failed
			await db
				.update(objects)
				.set({
					status: 'failed',
					metadata: {
						...meetingMetadata,
						error: err instanceof Error ? err.message : 'Bot scheduling failed',
					},
					updatedAt: new Date(),
				})
				.where(eq(objects.id, meetingId))
		}
	} else if (!shouldSendBot && entry.bot_id) {
		// Unschedule bot
		try {
			if (entry.recall_event_id) {
				await deleteBotFromEvent(entry.recall_event_id)
			}
		} catch (err) {
			logger.error('Failed to delete bot', {
				meetingId,
				error: err instanceof Error ? err.message : String(err),
			})
		}

		// Clean up maps — set to undefined, compact() in saveMaps filters them out
		botMap[entry.bot_id] = undefined as unknown as string
		entry.bot_id = undefined
		meetingMap[meetingId] = entry
		await saveMaps(db, integrationId, config, meetingMap, botMap)
	}
}

// ── Re-evaluation ────────────────────────────────────────────────────────────

/**
 * Compute what send_meeting_bot should be for a meeting given a mode.
 * For calendar-sourced meetings, is_organizer is stored in the meeting_map entry
 * or can be derived. For simplicity, we re-derive from the meeting's createdBy.
 */
function computeSendMeetingBot(autoJoinMode: string, metadata: Record<string, unknown>): boolean {
	if (autoJoinMode === 'all') return true
	if (autoJoinMode === 'manual') return false
	// organized_by_me: we don't have is_organizer in metadata anymore,
	// but we keep current value — settings re-eval only handles all/manual toggle
	return (metadata.send_meeting_bot as boolean) ?? false
}

/**
 * Re-evaluate all upcoming scheduled meetings when notetaker settings change.
 * Updates send_meeting_bot, language, and schedules/unschedules bots accordingly.
 */
export async function reevaluateMeetings(
	db: Database,
	workspaceId: string,
	autoJoinMode: string,
	language: string,
	botConfig?: Record<string, unknown>,
): Promise<void> {
	// Find calendar integration for this workspace
	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				inArray(integrations.provider, ['google-calendar', 'outlook-calendar']),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)

	if (!integration) return

	const config = integration.config as IntegrationMeetingConfig

	// Fetch all scheduled meetings within 1 week
	const oneWeekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
	const scheduledMeetings = await db
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'meeting'),
				eq(objects.status, 'scheduled'),
				sql`(${objects.metadata}->>'start')::timestamptz <= ${oneWeekFromNow}::timestamptz`,
			),
		)

	for (const meeting of scheduledMeetings) {
		const metadata = meeting.metadata as Record<string, unknown>
		const newSendBot = computeSendMeetingBot(autoJoinMode, metadata)
		const currentSendBot = (metadata.send_meeting_bot as boolean) ?? false
		const sendBotChanged = currentSendBot !== newSendBot
		const languageChanged = (metadata.language as string) !== language

		if (!sendBotChanged && !languageChanged) continue

		// Update metadata with new defaults
		const updatedMetadata = {
			...metadata,
			send_meeting_bot: newSendBot,
			language,
		}
		await db
			.update(objects)
			.set({ metadata: updatedMetadata, updatedAt: new Date() })
			.where(eq(objects.id, meeting.id))

		// Schedule or unschedule bot if send_meeting_bot changed
		if (sendBotChanged) {
			await scheduleOrUnscheduleBot(
				db,
				meeting.id,
				updatedMetadata,
				newSendBot,
				integration.id,
				config,
				botConfig,
			)
		}

		// Log event
		await db.insert(events).values({
			workspaceId,
			actorId: config.system_actor_id ?? meeting.createdBy,
			action: 'updated',
			entityType: 'meeting',
			entityId: meeting.id,
			data: { send_meeting_bot: newSendBot, language, reason: 'settings_changed' },
		})
	}
}
