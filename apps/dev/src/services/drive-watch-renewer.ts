import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { runDriveFanOut } from '../lib/integrations/providers/google-drive/fan-out'
import {
	type DriveIntegrationConfig,
	readPositiveIntEnv,
	renewDriveWatch,
} from '../lib/integrations/providers/google-drive/watch'
import { logger } from '../lib/logger'

const HOUR_MS = 60 * 60 * 1000
// Defaults sized for a 6 day channel (the ceiling we ask for). The S13 smoke
// records what Google really grants; if that is shorter, set these from it.
const TICK_MS = readPositiveIntEnv('GOOGLE_DRIVE_WATCH_TICK_MS', 6 * HOUR_MS)
const RENEW_WITHIN_MS = readPositiveIntEnv('GOOGLE_DRIVE_WATCH_RENEW_WITHIN_MS', 24 * HOUR_MS)
const POLL_MS = 24 * HOUR_MS

/**
 * Keeps Drive notification channels alive and backs them up with a poll.
 *
 * Renewal: Drive channels cannot be reactivated, so a channel inside the renew
 * window (or a row with none) gets a fresh changes.watch and the old one is
 * stopped, the change cursor carried across the swap.
 *
 * Fallback poll, once a day: reads changes.list for every active row from its
 * cursor and emits the same signals a webhook delivery would. It catches a
 * channel Google dropped without telling us (scope revocation, for one). It
 * shares the cursor compare-and-set with the webhook path, so a change both
 * see is emitted once.
 */
export class DriveWatchRenewer {
	private tickTimer: NodeJS.Timeout | null = null
	private pollTimer: NodeJS.Timeout | null = null
	private renewing = false
	private polling = false

	constructor(private db: Database) {}

	start(): void {
		if (this.tickTimer) return
		this.tickTimer = setInterval(() => this.tick(), TICK_MS)
		this.pollTimer = setInterval(() => this.poll(), POLL_MS)
		setTimeout(() => this.tick(), 30_000).unref()
		setTimeout(() => this.poll(), 5 * 60_000).unref()
	}

	stop(): void {
		if (this.tickTimer) clearInterval(this.tickTimer)
		if (this.pollTimer) clearInterval(this.pollTimer)
		this.tickTimer = null
		this.pollTimer = null
	}

	private async activeRows() {
		return this.db
			.select()
			.from(integrations)
			.where(and(eq(integrations.provider, 'google-drive'), eq(integrations.status, 'active')))
	}

	async tick(): Promise<void> {
		if (this.renewing) return
		this.renewing = true
		try {
			const rows = await this.activeRows()
			const threshold = Date.now() + RENEW_WITHIN_MS
			let renewed = 0
			let failed = 0
			for (const row of rows) {
				const drive = (row.config as DriveIntegrationConfig | null)?.drive
				if ((drive?.channelExpiresAt ?? 0) > threshold) continue
				try {
					await renewDriveWatch(this.db, row.id)
					renewed++
				} catch (err) {
					failed++
					logger.error('Drive watch renewal failed', {
						integrationId: row.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			if (renewed > 0 || failed > 0) {
				logger.info('Drive watch renewer tick', { renewed, failed, scanned: rows.length })
			}
		} finally {
			this.renewing = false
		}
	}

	async poll(): Promise<void> {
		if (this.polling) return
		this.polling = true
		try {
			const rows = await this.activeRows()
			let emitted = 0
			let failed = 0
			for (const row of rows) {
				try {
					emitted += (await runDriveFanOut(this.db, row.id)).emitted
				} catch (err) {
					failed++
					logger.error('Drive fallback poll failed', {
						integrationId: row.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			logger.info('Drive fallback poll', { scanned: rows.length, emitted, failed })
		} finally {
			this.polling = false
		}
	}
}
