import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { renewGmailWatch } from '../lib/integrations/providers/gmail/watch'
import type { GmailIntegrationConfig } from '../lib/integrations/providers/gmail/watch'
import { logger } from '../lib/logger'

const TICK_MS = 12 * 60 * 60 * 1000 // 12h
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000 // renew when <24h remaining

/**
 * Background loop that re-registers Gmail push watches before Google's 7-day cap.
 * Runs every 12h; renews any active gmail integration whose watchExpiresAt is
 * within 24h. Idempotent — calling users.watch repeatedly just refreshes the
 * expiration timestamp.
 */
export class GmailWatchRenewer {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(private db: Database) {}

	start(): void {
		if (this.timer) return
		// Run once shortly after boot, then on cadence.
		this.timer = setInterval(() => this.tick(), TICK_MS)
		setTimeout(() => this.tick(), 30_000).unref()
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
			const rows = await this.db
				.select()
				.from(integrations)
				.where(and(eq(integrations.provider, 'gmail'), eq(integrations.status, 'active')))

			const threshold = Date.now() + RENEW_WITHIN_MS
			let renewed = 0
			let failed = 0

			for (const row of rows) {
				const config = (row.config as GmailIntegrationConfig | null) ?? {}
				const expires = config.gmail?.watchExpiresAt ?? 0
				// Renew if expiring soon OR if watch was never registered (expires=0).
				if (expires > threshold) continue
				try {
					await renewGmailWatch(this.db, row.id)
					renewed++
				} catch (err) {
					failed++
					logger.error('Gmail watch renewal failed', {
						integrationId: row.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			if (renewed > 0 || failed > 0) {
				logger.info('Gmail watch renewer tick', { renewed, failed, scanned: rows.length })
			}
		} finally {
			this.running = false
		}
	}
}
