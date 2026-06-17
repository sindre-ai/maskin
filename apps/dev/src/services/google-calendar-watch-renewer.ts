import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import type { GoogleCalendarIntegrationConfig } from '../lib/integrations/providers/google-calendar/watch'
import { renewGoogleCalendarWatch } from '../lib/integrations/providers/google-calendar/watch'
import { logger } from '../lib/logger'

const TICK_MS = 12 * 60 * 60 * 1000 // 12h
// Renew when <48h remain on the channel. Google caps Calendar push channels at
// ~7 days; the 24h margin we use for Gmail was flagged by Devon as too thin
// under hostile renewer-downtime conditions (see insight ada777d9). 48h gives
// us up to ~24h of renewer downtime AND a tick budget without the cap biting.
const RENEW_WITHIN_MS = 48 * 60 * 60 * 1000

/**
 * Background loop that re-registers Google Calendar push channels before
 * Google's 7-day cap, and (as side-effect of `renewGoogleCalendarWatch`) stops
 * the previous channel — so orphans from earlier rotations are reaped.
 *
 * Runs every 12h; renews any active google-calendar integration whose channel
 * expiration is within 48h. Idempotent at the per-integration level —
 * renew creates a fresh channel and stops the old one. Re-running while a
 * channel is still fresh is a no-op (the row is skipped).
 */
export class GoogleCalendarWatchRenewer {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(private db: Database) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), TICK_MS)
		// First tick shortly after boot to catch channels that expired while down.
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
				.where(and(eq(integrations.provider, 'google-calendar'), eq(integrations.status, 'active')))

			const threshold = Date.now() + RENEW_WITHIN_MS
			let renewed = 0
			let failed = 0

			for (const row of rows) {
				const config = (row.config as GoogleCalendarIntegrationConfig | null) ?? {}
				const expires = config.googleCalendar?.channelExpiration ?? 0
				// Renew if expiring soon OR if no channel was ever registered (expires=0).
				if (expires > threshold) continue
				try {
					await renewGoogleCalendarWatch(this.db, row.id)
					renewed++
				} catch (err) {
					failed++
					logger.error('Google Calendar watch renewal failed', {
						integrationId: row.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			if (renewed > 0 || failed > 0) {
				logger.info('Google Calendar watch renewer tick', { renewed, failed, scanned: rows.length })
			}
		} finally {
			this.running = false
		}
	}
}
