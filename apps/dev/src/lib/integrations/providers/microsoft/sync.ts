import type { Database } from '@maskin/db'
import { integrations, objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { trackMeetingTranscriptLanded } from '../../../analytics/integration-events'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import type { PostInstallContext } from '../../types'
import { saveMeeting } from '../skjald/meeting-sync'
import { MICROSOFT_PROVIDER } from './config'
import { GRAPH_BASE, type GraphDeps, GraphError, graphJson, graphPages, graphText } from './graph'
import { vttToMarkdown } from './vtt'

/** How far back the calendar is searched on each run. Transcripts appear up to ~30 minutes after a meeting ends; the rest is slack for an outage. */
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000
/** Most events looked at per run, newest first. */
const MAX_EVENTS = 50
/** A recurring meeting has one online meeting for the whole series; a transcript belongs to the occurrence it started in. */
const TRANSCRIPT_START_SLACK_BEFORE_MS = 30 * 60 * 1000
const TRANSCRIPT_START_SLACK_AFTER_MS = 2 * 60 * 60 * 1000

/** Plain words on the Settings tile. Read from integrations.config.status_note by web and iOS. */
export const TILE_NOTE_DEFAULT =
	'Lands Teams meetings from your calendar that had transcription on. Instant meetings and channel meetings are not included.'
export const TILE_NOTE_TRANSCRIPTS_OFF = 'Your IT admin has not turned on transcript access'

export const meetingExternalId = (meetingId: string, transcriptId: string) =>
	`msteams:${meetingId}:${transcriptId}`

interface CalendarEvent {
	id: string
	subject?: string | null
	isCancelled?: boolean
	isOnlineMeeting?: boolean
	onlineMeetingProvider?: string | null
	onlineMeeting?: { joinUrl?: string | null } | null
	type?: string
	start?: { dateTime: string }
	end?: { dateTime: string }
}

interface OnlineMeeting {
	id: string
}

interface CallTranscript {
	id: string
	meetingId?: string
	createdDateTime?: string
	endDateTime?: string
}

/** Graph returns UTC wall-clock times without a zone when asked with Prefer outlook.timezone="UTC". */
const utc = (dateTime: string) =>
	new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dateTime) ? dateTime : `${dateTime}Z`)

export interface MicrosoftIntegrationRow {
	id: string
	workspaceId: string
	createdBy: string
	config: unknown
}

export interface SyncDeps extends GraphDeps {
	now?: () => Date
	getAccessToken?: (db: Database, integrationId: string) => Promise<string>
}

// Imported lazily: the registry imports this file for the postInstall hook.
async function defaultAccessToken(db: Database, integrationId: string): Promise<string> {
	const { getProvider } = await import('../../registry')
	return new TokenManager().getValidToken(db, integrationId, getProvider(MICROSOFT_PROVIDER))
}

/** Set the Settings tile line. Writes only when it changes; returns whether it did. */
async function setTileNote(
	db: Database,
	row: MicrosoftIntegrationRow,
	note: string,
): Promise<boolean> {
	const current = (row.config as { status_note?: string } | null)?.status_note
	if (current === note) return false
	await db
		.update(integrations)
		.set({
			config: sql`COALESCE(${integrations.config}, '{}'::jsonb) || ${JSON.stringify({ status_note: note })}::jsonb`,
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, row.id))
	row.config = { ...((row.config as object | null) ?? {}), status_note: note }
	return true
}

async function eventAlreadyLanded(
	db: Database,
	workspaceId: string,
	eventId: string,
): Promise<boolean> {
	const [hit] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'meeting'),
				sql`${objects.metadata}->>'_ms_event_id' = ${eventId}`,
			),
		)
		.limit(1)
	return Boolean(hit)
}

const isTeamsEvent = (e: CalendarEvent) =>
	e.isOnlineMeeting === true &&
	e.onlineMeetingProvider === 'teamsForBusiness' &&
	!e.isCancelled &&
	Boolean(e.onlineMeeting?.joinUrl)

/**
 * One poll for one connected account: find the calendar events from the last
 * days that were Teams meetings and have ended, list the transcripts of each,
 * and upsert a meeting object per transcript. Keyed on Graph meeting id plus
 * transcript id, so a run that sees the same transcript again (or Microsoft
 * delivering it twice) updates the same object. Returns the number of
 * transcripts written.
 *
 * Does not reach instant meetings with no calendar entry or channel meetings;
 * the tile says so. Whether meetings someone else organized come through a
 * signed-in read is settled by the end to end check, not here.
 */
export async function syncMicrosoftIntegration(
	db: Database,
	row: MicrosoftIntegrationRow,
	deps: SyncDeps = {},
): Promise<number> {
	const now = (deps.now ?? (() => new Date()))()
	const accessToken = await (deps.getAccessToken ?? defaultAccessToken)(db, row.id)
	const graph: GraphDeps = { fetch: deps.fetch, sleep: deps.sleep }

	const events = (
		await graphPages<CalendarEvent>(
			`${GRAPH_BASE}/me/calendarView?startDateTime=${encodeURIComponent(
				new Date(now.getTime() - LOOKBACK_MS).toISOString(),
			)}&endDateTime=${encodeURIComponent(now.toISOString())}&$top=${MAX_EVENTS}&$select=id,subject,isCancelled,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,type,start,end`,
			accessToken,
			graph,
			{ Prefer: 'outlook.timezone="UTC"' },
			2,
		)
	)
		.filter(isTeamsEvent)
		.filter((e) => e.end && utc(e.end.dateTime) <= now)
		.sort((a, b) => utc(b.end?.dateTime ?? '').getTime() - utc(a.end?.dateTime ?? '').getTime())
		.slice(0, MAX_EVENTS)

	const meetingIdByJoinUrl = new Map<string, string | null>()
	let written = 0
	let transcriptsListed = false

	for (const event of events) {
		if (await eventAlreadyLanded(db, row.workspaceId, event.id)) continue
		const joinUrl = event.onlineMeeting?.joinUrl as string

		try {
			if (!meetingIdByJoinUrl.has(joinUrl)) {
				const found = await graphJson<{ value?: OnlineMeeting[] }>(
					`${GRAPH_BASE}/me/onlineMeetings?$filter=JoinWebUrl%20eq%20'${encodeURIComponent(
						joinUrl.replace(/'/g, "''"),
					)}'`,
					accessToken,
					graph,
				)
				meetingIdByJoinUrl.set(joinUrl, found.value?.[0]?.id ?? null)
			}
			const meetingId = meetingIdByJoinUrl.get(joinUrl)
			if (!meetingId) continue

			const start = utc(event.start?.dateTime ?? '')
			const end = utc(event.end?.dateTime ?? '')
			const recurring = event.type === 'occurrence' || event.type === 'exception'
			const transcripts = (
				await graphPages<CallTranscript>(
					`${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
					accessToken,
					graph,
				)
			).filter((t) => {
				if (!recurring || !t.createdDateTime) return true
				const startedAt = new Date(t.createdDateTime).getTime()
				return (
					startedAt >= start.getTime() - TRANSCRIPT_START_SLACK_BEFORE_MS &&
					startedAt <= end.getTime() + TRANSCRIPT_START_SLACK_AFTER_MS
				)
			})
			transcriptsListed = true

			for (const transcript of transcripts) {
				const vtt = await graphText(
					`${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(
						transcript.id,
					)}/content?$format=text/vtt`,
					accessToken,
					'text/vtt',
					graph,
				)
				const content = vttToMarkdown(vtt)
				// Still being processed: try again on the next run.
				if (!content) continue

				const externalId = meetingExternalId(meetingId, transcript.id)
				await saveMeeting(db, {
					workspaceId: row.workspaceId,
					systemActorId: row.createdBy,
					externalId,
					title: event.subject?.trim() || 'Untitled Teams meeting',
					content,
					metadata: (existing) => ({
						...(existing ?? {}),
						external_id: externalId,
						source: 'microsoft-teams',
						started_at: transcript.createdDateTime ?? start.toISOString(),
						// `_`-prefixed: hidden from the Properties panel (see skjald/meeting-sync.ts).
						_ms_event_id: event.id,
					}),
				})
				written++
				void trackMeetingTranscriptLanded({
					provider: MICROSOFT_PROVIDER,
					actorId: row.createdBy,
					ok: true,
				}).catch(() => {})
			}
		} catch (err) {
			if (err instanceof GraphError && err.isTranscriptsDisabled) {
				// Once when it turns off, not on every run while it stays off.
				if (await setTileNote(db, row, TILE_NOTE_TRANSCRIPTS_OFF)) {
					void trackMeetingTranscriptLanded({
						provider: MICROSOFT_PROVIDER,
						actorId: row.createdBy,
						ok: false,
					}).catch(() => {})
				}
				return written
			}
			// One event failing (a meeting this account cannot read, a bad link) must not
			// stop the others; the next run looks at it again.
			logger.warn('Microsoft event sync failed', {
				integrationId: row.id,
				status: err instanceof GraphError ? err.status : undefined,
				code: err instanceof GraphError ? err.code : undefined,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	// A transcripts call answered, so access is on (again): put the standing line back.
	if (transcriptsListed) await setTileNote(db, row, TILE_NOTE_DEFAULT)
	return written
}

/** Poll every connected Microsoft account. One failing does not stop the others. */
export async function syncAllMicrosoftIntegrations(
	db: Database,
	deps: SyncDeps = {},
): Promise<void> {
	const rows = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			createdBy: integrations.createdBy,
			config: integrations.config,
		})
		.from(integrations)
		.where(and(eq(integrations.provider, MICROSOFT_PROVIDER), eq(integrations.status, 'active')))

	for (const row of rows) {
		try {
			await syncMicrosoftIntegration(db, row, deps)
		} catch (err) {
			// A revoked grant flips the row to revoked in TokenManager; the rest is retried next tick.
			logger.error('Microsoft sync failed', {
				integrationId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
}

/** postInstall: put the standing line on the tile so it is there before the first poll. */
export async function setupMicrosoftInstall(ctx: PostInstallContext): Promise<void> {
	const db = ctx.db as Database
	await db
		.update(integrations)
		.set({
			config: sql`COALESCE(${integrations.config}, '{}'::jsonb) || ${JSON.stringify({ status_note: TILE_NOTE_DEFAULT })}::jsonb`,
		})
		.where(eq(integrations.id, ctx.integrationId))
}
