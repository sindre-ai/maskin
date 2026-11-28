import type { Database } from '@maskin/db'
import { trash } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { Cron } from 'croner'
import { eq, lte } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { AgentStorageManager } from '../services/agent-storage'

/**
 * Trash purge.
 *
 * A deleted row stays in `trash` for 30 days so a person can restore it. Once
 * purge_at passes, the row is gone for good: this job removes the stored bytes
 * first (files, workspace skills), then deletes the trash row. Rows with no bytes
 * (objects, triggers, relationships) are simpler: delete the row.
 *
 * If the byte delete fails, the row is left for the next run so the bytes are not
 * orphaned. Every tick is swallowed and logged so one bad row cannot stop the rest.
 *
 * Daily at 03:23 UTC, off the round hour so it does not pile up with the other
 * nightly maintenance jobs.
 */
const CRON_EXPRESSION = '23 3 * * *'

export class TrashPurgeJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private storageProvider: StorageProvider,
		private agentStorage: AgentStorageManager,
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

	/** Returns the number of trash rows removed. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		let removed = 0
		try {
			const expired = await this.db.select().from(trash).where(lte(trash.purgeAt, new Date()))
			for (const entry of expired) {
				const row = entry.row as Record<string, unknown>
				try {
					if (entry.kind === 'file' && typeof row.storageKey === 'string') {
						await this.storageProvider.delete(row.storageKey)
					} else if (entry.kind === 'workspace_skill') {
						await this.agentStorage.deleteWorkspaceSkill(entry.workspaceId, entry.entityId)
					}
				} catch (err) {
					logger.error('Trash purge: stored bytes could not be removed, retrying next run', {
						trashId: entry.id,
						kind: entry.kind,
						error: err instanceof Error ? err.message : String(err),
					})
					continue
				}
				await this.db.delete(trash).where(eq(trash.id, entry.id))
				removed += 1
			}
			if (expired.length > 0) {
				logger.info('Trash purge tick', { expired: expired.length, removed })
			}
		} catch (err) {
			logger.error('Trash purge tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
		return removed
	}
}
