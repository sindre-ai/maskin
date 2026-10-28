import type { Database } from '@maskin/db'
import { voiceToolCalls } from '@maskin/db/schema'
import { lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

const TICK_MS = 6 * 60 * 60 * 1000 // 6h
export const VOICE_TOOL_CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30d

/**
 * Background loop that deletes voice tool call log rows older than the retention
 * window. The log is for diagnosing recent calls and holds redacted slices of
 * customer content, so it is kept only as long as a support question about a
 * call is plausible. Rows also go with their voice session or workspace
 * (ON DELETE CASCADE).
 */
export class VoiceToolCallLogCleaner {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private retentionMs: number = VOICE_TOOL_CALL_RETENTION_MS,
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

	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const cutoff = new Date(now.getTime() - this.retentionMs)
			const deleted = await this.db
				.delete(voiceToolCalls)
				.where(lt(voiceToolCalls.startedAt, cutoff))
				.returning({ id: voiceToolCalls.id })
			if (deleted.length > 0) {
				logger.info('Voice tool call log cleaner tick', {
					deleted: deleted.length,
					cutoff: cutoff.toISOString(),
				})
			}
			return deleted.length
		} catch (err) {
			logger.error('Voice tool call log cleaner tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return 0
		} finally {
			this.running = false
		}
	}
}
