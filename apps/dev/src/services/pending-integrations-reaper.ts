import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

const TICK_MS = 5 * 60 * 1000 // 5m
const STALE_THRESHOLD_MS = 15 * 60 * 1000 // 15m

/**
 * Deletes `integrations` rows still marked `pending` past the stale threshold.
 *
 * Each `POST /api/integrations/:provider/connect` writes a `pending` row that
 * carries the one-time OAuth state nonce. The callback either upgrades it to
 * `active` or discards it — but if the user closes the tab, denies at the
 * provider, or hits a network error mid-round-trip, the pending row is
 * orphaned. Left alone it (a) shows up as a stuck "connecting…" row in the
 * settings UI and (b) collides with the partial unique index on
 * (workspace_id, provider, external_id) if the user retries with the same
 * nonce (impossible, since nonces are random) or with a returning installation
 * id (possible for GitHub reinstalls).
 *
 * The 15 minute cutoff matches the 10-minute state TTL enforced in the
 * callback route (`state.ts > 10 * 60 * 1000` → `state expired`) with 5 min
 * of headroom for clock skew and long round-trips.
 */
export class PendingIntegrationsReaper {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private staleThresholdMs: number = STALE_THRESHOLD_MS,
		private tickMs: number = TICK_MS,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), this.tickMs)
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
			const cutoff = new Date(Date.now() - this.staleThresholdMs)
			const reaped = await this.db
				.delete(integrations)
				.where(and(eq(integrations.status, 'pending'), lt(integrations.updatedAt, cutoff)))
				.returning({
					id: integrations.id,
					provider: integrations.provider,
					workspaceId: integrations.workspaceId,
				})
			if (reaped.length > 0) {
				logger.info('Reaped stale pending integration rows', {
					count: reaped.length,
					cutoff: cutoff.toISOString(),
					providers: [...new Set(reaped.map((r) => r.provider))],
					sample: reaped.slice(0, 5).map((r) => ({
						id: r.id,
						provider: r.provider,
						workspaceId: r.workspaceId,
					})),
				})
			}
		} catch (err) {
			logger.error('Pending integrations reaper tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
