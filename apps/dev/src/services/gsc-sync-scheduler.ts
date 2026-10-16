import type { Database } from '@maskin/db'
import { syncAllGscIntegrations } from '../lib/integrations/providers/google-search-console/sync'
import { logger } from '../lib/logger'

const TICK_MS = 6 * 60 * 60 * 1000 // 6h
const TICK_TIMEOUT_MS = 60 * 60 * 1000 // 1h

/**
 * Background loop for the daily Search Console sync. Ticks every 6h; an
 * integration that is already current for the day returns without calling
 * Google, so a healthy one syncs once a day. A failed run is retried on the
 * next tick, which is what lets a failure streak be measured against 24h.
 */
export class GscSyncScheduler {
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
			// Bound the whole batch: a hung await (dead DB connection) would otherwise pin
			// `running` and silently stop the sync for every workspace. The hung work
			// carries on detached with its rejection swallowed.
			const batch = syncAllGscIntegrations(this.db)
			batch.catch(() => {})
			const timedOut = new Promise<'timeout'>((resolve) => {
				timer = setTimeout(() => resolve('timeout'), this.tickTimeoutMs)
			})
			if ((await Promise.race([batch, timedOut])) === 'timeout') {
				logger.error('GSC sync scheduler tick timed out; releasing the tick', {
					timeoutMs: this.tickTimeoutMs,
				})
			}
		} catch (err) {
			logger.error('GSC sync scheduler tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			clearTimeout(timer)
			this.running = false
		}
	}
}
