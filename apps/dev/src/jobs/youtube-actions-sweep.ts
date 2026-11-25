import type { Database } from '@maskin/db'
import { youtubeActionAudit, youtubePendingActions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { Cron } from 'croner'
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import {
	YOUTUBE_ACTION_ROW_RETENTION_MS,
	YOUTUBE_AUDIT_RETENTION_MS,
	YOUTUBE_CLAIM_STALE_MS,
	endYoutubeAction,
	expireYoutubeActions,
	writeYoutubeAudit,
} from '../lib/youtube/actions'
import { resumeInterruptedYoutubeUploads, scheduleYoutubeExecution } from '../lib/youtube/executor'

/**
 * Housekeeping for the YouTube approval gate, every 5 minutes:
 * - expires held actions nobody decided in 7 days (payload cleared, audit row written),
 * - runs an approved action the server never started (a restart between the tap and the run),
 * - carries on an upload that was cut off from the progress stored with it,
 * - marks any other claimed action with no result as failed instead of running it twice,
 * - deletes ended actions after 30 days (their payload is already gone) and the decision audit
 *   after 12 months.
 * Mirrors PurgeIdempotencyJob: a swallowed-error tick, guarded against overlapping runs.
 */
const CRON_EXPRESSION = '*/5 * * * *'
/** An approval younger than this is left to the request that made it. */
const APPROVAL_GRACE_MS = 60 * 1000

export class YoutubeActionsSweepJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private cronExpression: string = CRON_EXPRESSION,
		/** Where an upload that is carried on reads its video from. */
		private storage?: StorageProvider,
	) {}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const expired = await expireYoutubeActions(this.db)

			const orphans = await this.db
				.select({ id: youtubePendingActions.id })
				.from(youtubePendingActions)
				.where(
					and(
						eq(youtubePendingActions.status, 'approved'),
						isNull(youtubePendingActions.claimedAt),
						lt(youtubePendingActions.decidedAt, new Date(Date.now() - APPROVAL_GRACE_MS)),
					),
				)
			// Started in the background: an upload can run for a long time, and this tick must not wait for it.
			for (const { id } of orphans) scheduleYoutubeExecution(this.db, id, this.storage)

			const resumedUploads = await resumeInterruptedYoutubeUploads(this.db, {
				storage: this.storage,
			})

			const stuck = await this.db
				.select()
				.from(youtubePendingActions)
				.where(
					and(
						eq(youtubePendingActions.status, 'approved'),
						isNotNull(youtubePendingActions.claimedAt),
						lt(youtubePendingActions.claimedAt, new Date(Date.now() - YOUTUBE_CLAIM_STALE_MS)),
						// An upload with a session is resumed above, not failed: its bytes are safe at Google.
						sql`NOT (${youtubePendingActions.kind} = 'upload_video' AND ${youtubePendingActions.uploadSessionUri} IS NOT NULL)`,
					),
				)
			for (const row of stuck) {
				await endYoutubeAction(this.db, row, { status: 'failed', resultCode: 'interrupted' })
				await writeYoutubeAudit(this.db, row, { decision: 'failed', resultCode: 'interrupted' })
			}

			const rows = await this.db
				.delete(youtubePendingActions)
				.where(
					and(
						inArray(youtubePendingActions.status, ['rejected', 'expired', 'executed', 'failed']),
						lt(
							youtubePendingActions.createdAt,
							new Date(Date.now() - YOUTUBE_ACTION_ROW_RETENTION_MS),
						),
					),
				)
				.returning({ id: youtubePendingActions.id })
			const audit = await this.db
				.delete(youtubeActionAudit)
				.where(lt(youtubeActionAudit.createdAt, new Date(Date.now() - YOUTUBE_AUDIT_RETENTION_MS)))
				.returning({ id: youtubeActionAudit.id })

			if (
				expired + orphans.length + resumedUploads + stuck.length + rows.length + audit.length >
				0
			) {
				logger.info('YouTube actions sweep tick', {
					expired,
					resumed: orphans.length,
					resumedUploads,
					interrupted: stuck.length,
					rowsDeleted: rows.length,
					auditDeleted: audit.length,
				})
			}
		} catch (err) {
			logger.error('YouTube actions sweep tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
