import type { Database } from '@maskin/db'
import { syncAllGscIntegrations } from '../lib/integrations/providers/google-search-console/sync'
import { logger } from '../lib/logger'

const TICK_MS = 6 * 60 * 60 * 1000 // 6h

/**
 * Background loop for the daily Search Console sync. Ticks every 6h; an
 * integration that is already current for the day returns without calling
 * Google, so a healthy one syncs once a day. A failed run is retried on the
 * next tick, which is what lets a failure streak be measured against 24h.
 */
export class GscSyncScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(private db: Database) {}

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
			await syncAllGscIntegrations(this.db)
		} catch (err) {
			logger.error('GSC sync scheduler tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
