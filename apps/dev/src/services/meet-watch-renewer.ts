import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { MeetToolError } from '../lib/integrations/providers/google-meet/errors'
import { renewMeetWatch } from '../lib/integrations/providers/google-meet/watch'
import type { MeetIntegrationConfig } from '../lib/integrations/providers/google-meet/watch'
import { logger } from '../lib/logger'

const TICK_MS = 12 * 60 * 60 * 1000
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000

/**
 * Mirrors GmailWatchRenewer — 12h cadence, renews any active google-meet
 * subscription whose expiry is within 24h. Idempotent — reactivating a live
 * subscription just extends its TTL; delete+recreate is the fallback when
 * Meet's subscriptions:reactivate isn't available.
 *
 * A MEETING_NOT_OWNED_BY_ACTOR failure is permanent (another workspace hosts the
 * call), so the row is flagged config.meet.renewalBlocked and skipped from then
 * on. Reconnecting Google Meet rewrites config.meet and clears the flag.
 */
export class MeetWatchRenewer {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(private db: Database) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), TICK_MS)
		setTimeout(() => this.tick(), 30_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	private async blockRenewal(integrationId: string): Promise<void> {
		try {
			await this.db
				.update(integrations)
				.set({
					config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{meet,renewalBlocked}', 'true'::jsonb, true)`,
					updatedAt: new Date(),
				})
				.where(eq(integrations.id, integrationId))
		} catch (err) {
			logger.error('Meet watch renewalBlocked flag write failed', {
				integrationId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	private async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const rows = await this.db
				.select()
				.from(integrations)
				.where(and(eq(integrations.provider, 'google-meet'), eq(integrations.status, 'active')))

			const threshold = Date.now() + RENEW_WITHIN_MS
			let renewed = 0
			let failed = 0
			let skipped = 0
			for (const row of rows) {
				const config = (row.config as MeetIntegrationConfig | null) ?? {}
				if (config.meet?.renewalBlocked) continue
				const expires = config.meet?.subscriptionExpiresAt ?? 0
				if (expires > threshold) continue
				try {
					await renewMeetWatch(this.db, row.id)
					renewed++
				} catch (err) {
					if (
						err instanceof MeetToolError &&
						err.envelope.error.code === 'MEETING_NOT_OWNED_BY_ACTOR'
					) {
						skipped++
						await this.blockRenewal(row.id)
						logger.warn('Meet watch not renewable, skipping from now on', {
							integrationId: row.id,
							error: err.message,
						})
						continue
					}
					failed++
					logger.error('Meet watch renewal failed', {
						integrationId: row.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			if (renewed > 0 || failed > 0 || skipped > 0) {
				logger.info('Meet watch renewer tick', { renewed, failed, skipped, scanned: rows.length })
			}
		} finally {
			this.running = false
		}
	}
}
