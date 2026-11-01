import type { Database } from '@maskin/db'
import { researchRuns } from '@maskin/db/schema'
import { Cron } from 'croner'
import { and, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * Deletes the raw web quotes kept on deep_research runs (spec 7.6).
 *
 * A run's findings hold quotes copied from web pages. They are blanked once the run
 * is RESEARCH_FINDINGS_RETENTION_DAYS old, counted from finished_at, or from created_at
 * when the run never finished. The report, sources, cost, tokens, warnings and stages
 * stay. A queued or running run is never touched, whatever its age.
 *
 * Idempotent and safe on two servers at once: the UPDATE only matches rows whose
 * findings are not already blank, so a second pass changes nothing and needs no lock.
 *
 * Runs once a day from the API process, and once on boot (index.ts calls tick()), so a
 * server that was down at the scheduled time still catches up.
 */
const CRON_EXPRESSION = '41 3 * * *'

export const RESEARCH_FINDINGS_RETENTION_DAYS = 30
const RETENTION_MS = RESEARCH_FINDINGS_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Blanks findings older than the window. Returns the number of runs cleared. */
export async function purgeExpiredResearchFindings(
	db: Database,
	now: Date = new Date(),
	retentionMs: number = RETENTION_MS,
): Promise<number> {
	const cutoff = new Date(now.getTime() - retentionMs)
	const rows = await db
		.update(researchRuns)
		.set({ findings: null })
		.where(
			and(
				notInArray(researchRuns.status, ['queued', 'running']),
				lt(
					sql`coalesce(${researchRuns.finishedAt}, ${researchRuns.createdAt})`,
					cutoff.toISOString(),
				),
				isNotNull(researchRuns.findings),
				sql`${researchRuns.findings} <> '[]'::jsonb`,
			),
		)
		.returning({ id: researchRuns.id })
	return rows.length
}

export class ResearchFindingsCleanupJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private cronExpression: string = CRON_EXPRESSION,
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

	/** Returns the number of runs cleared. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const cleared = await purgeExpiredResearchFindings(this.db)
			if (cleared > 0) {
				logger.info('Cleared expired deep_research findings', {
					cleared,
					retention_days: RESEARCH_FINDINGS_RETENTION_DAYS,
				})
			}
			return cleared
		} catch (err) {
			logger.error('deep_research findings cleanup failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return 0
		} finally {
			this.running = false
		}
	}
}
