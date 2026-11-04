import type { Database } from '@maskin/db'
import { blockedToolCalls } from '@maskin/db/schema'
import { lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

const TICK_MS = 6 * 60 * 60 * 1000 // 6h
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30d

/**
 * Background loop that trims old rows from `blocked_tool_calls`. The table
 * feeds the "Attempted" chip on the Agent access grid, which looks back 30
 * days, so older rows serve nothing and just consume storage.
 */
export class BlockedToolCallsCleaner {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private retentionMs: number = RETENTION_MS,
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

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const cutoff = new Date(Date.now() - this.retentionMs)
			const deleted = await this.db
				.delete(blockedToolCalls)
				.where(lt(blockedToolCalls.blockedAt, cutoff))
				.returning({ id: blockedToolCalls.id })
			if (deleted.length > 0) {
				logger.info('Blocked tool calls cleaner tick', {
					deleted: deleted.length,
					cutoff: cutoff.toISOString(),
				})
			}
		} catch (err) {
			logger.error('Blocked tool calls cleaner tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
