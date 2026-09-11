import type { Database } from '@maskin/db'
import { integrations, objects } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { getProvider } from '../lib/integrations/registry'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import {
	reconcileMeetingArtefacts,
} from '../lib/integrations/providers/google-meet/watch'
import { writeMeetingMetadata } from '../lib/integrations/providers/google-meet/meeting-metadata'
import { logger } from '../lib/logger'

const TICK_MS = 24 * 60 * 60 * 1000 // daily
const WINDOW_LATE_MS = 30 * 60 * 1000 // ignore meetings <30min old
const WINDOW_EARLY_MS = 72 * 60 * 60 * 1000 // 72h cutoff before giving up

/**
 * Daily sweep that back-fills transcripts for meetings where the Pub/Sub push
 * was dropped. Scans meeting objects with google_meet_space_name set +
 * transcript_status != 'ready' inside the [now-72h, now-30min] window; runs
 * the same fan-out path under the workspace's host token. After 72h with
 * nothing arriving, marks the meeting artefact_state='not_recorded' +
 * transcript_status='unavailable' per §6 of the reshape spec.
 */
export class MeetTranscriptReconciler {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private storage: StorageProvider,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), TICK_MS)
		setTimeout(() => this.tick(), 60_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	private async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const now = Date.now()
			const lateThresholdIso = new Date(now - WINDOW_LATE_MS).toISOString()
			const earlyThresholdIso = new Date(now - WINDOW_EARLY_MS).toISOString()
			const meetings = await this.db
				.select({
					id: objects.id,
					workspaceId: objects.workspaceId,
					metadata: objects.metadata,
				})
				.from(objects)
				.where(
					and(
						eq(objects.type, 'meeting'),
						sql`${objects.metadata}->>'google_meet_space_name' IS NOT NULL`,
						sql`COALESCE(${objects.metadata}->>'transcript_status', 'pending') <> 'ready'`,
						sql`(${objects.metadata}->>'meeting_date')::timestamptz <= ${lateThresholdIso}::timestamptz`,
						sql`(${objects.metadata}->>'meeting_date')::timestamptz >= ${earlyThresholdIso}::timestamptz`,
					),
				)
			if (meetings.length === 0) return
			let filled = 0
			let markedUnavailable = 0
			for (const meeting of meetings) {
				const md = (meeting.metadata as Record<string, unknown> | null) ?? {}
				const spaceName = md.google_meet_space_name as string | undefined
				const meetingDate = md.meeting_date as string | undefined
				const meetingAge = meetingDate ? now - Date.parse(meetingDate) : 0

				try {
					const accessToken = await this.getRowToken(meeting.workspaceId)
					if (!accessToken) continue
					const wrote = await reconcileMeetingArtefacts(
						this.db,
						accessToken,
						meeting.workspaceId,
						meeting.id,
						spaceName,
						this.storage,
					)
					if (wrote) {
						filled++
					} else if (meetingAge >= WINDOW_EARLY_MS - TICK_MS) {
						await writeMeetingMetadata(this.db, meeting.id, {
							transcript_status: 'unavailable',
							artefact_state: 'not_recorded',
							artefact_last_polled_at: new Date().toISOString(),
						})
						markedUnavailable++
					} else {
						await writeMeetingMetadata(this.db, meeting.id, {
							artefact_last_polled_at: new Date().toISOString(),
						})
					}
				} catch (err) {
					logger.warn('Meet transcript reconciler failed for meeting', {
						meetingId: meeting.id,
						workspaceId: meeting.workspaceId,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			logger.info('Meet transcript reconciler tick', {
				scanned: meetings.length,
				filled,
				markedUnavailable,
			})
		} finally {
			this.running = false
		}
	}

	private async getRowToken(workspaceId: string): Promise<string | null> {
		const [row] = await this.db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, 'google-meet'),
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)
		if (!row) return null
		const tokenManager = new TokenManager()
		try {
			return await tokenManager.getValidToken(this.db, row.id, getProvider('google-meet'))
		} catch (err) {
			logger.warn('Meet reconciler token fetch failed', {
				workspaceId,
				integrationId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
			return null
		}
	}
}
