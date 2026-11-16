import type { Database } from '@maskin/db'
import { syncAllMicrosoftIntegrations } from '../lib/integrations/providers/microsoft/sync'
import { logger } from '../lib/logger'

const TICK_MS = 15 * 60 * 1000 // 15 min: a transcript should land within 30 minutes of the meeting ending
const TICK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Background loop that lands Teams transcripts as meetings. Microsoft is polled,
 * not pushed. Each tick looks at the last few days of every connected account's
 * calendar and skips what has already landed, so a quiet account costs one
 * calendar read.
 */
export class MicrosoftSyncScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private tickTimeoutMs = TICK_TIMEOUT_MS,
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
		let timer: NodeJS.Timeout | undefined
		try {
			// Bound the batch: a hung await would otherwise pin `running` and stop the sync for everyone.
			const batch = syncAllMicrosoftIntegrations(this.db)
			batch.catch(() => {})
			const timedOut = new Promise<'timeout'>((resolve) => {
				timer = setTimeout(() => resolve('timeout'), this.tickTimeoutMs)
			})
			if ((await Promise.race([batch, timedOut])) === 'timeout') {
				logger.error('Microsoft sync scheduler tick timed out; releasing the tick', {
					timeoutMs: this.tickTimeoutMs,
				})
			}
		} catch (err) {
			logger.error('Microsoft sync scheduler tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			clearTimeout(timer)
			this.running = false
		}
	}
}
