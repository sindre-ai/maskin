import type { Database } from '@maskin/db'
import { logger } from '../lib/logger'
import {
	SELF_HEAL_DEFAULT_LIMIT,
	SELF_HEAL_GRACE_MS,
	SELF_HEAL_LOOKBACK_MS,
	SELF_HEAL_RECENT_LOOKBACK_MS,
	SessionReconciler,
} from './session-reconciler'

const TICK_MS = 60 * 1000 // 1m, matches SELF_HEAL_GRACE_MS
/** How often the wide sweep over the full lookback window repeats. */
const FULL_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Periodic caller for the §9.4 self-heal check. Every tick back-fills the
 * `session_*` events row for terminal-status sessions that never got one
 * (see SessionReconciler.selfHealTerminalWithoutEvents). Ticks never overlap:
 * a slow pass makes the next tick a no-op instead of stacking queries.
 *
 * Most ticks only look at the last few minutes. The wide sweep over the full
 * lookback window (which re-probes `events` for every terminal session in it)
 * runs on the first tick after boot, then once an hour — enough to repair
 * whatever a long outage left behind without paying for it every minute.
 */
export class SessionSelfHealJob {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private lastFullSweepAt = 0
	private reconciler: SessionReconciler

	constructor(
		db: Database,
		private tickMs: number = TICK_MS,
	) {
		this.reconciler = new SessionReconciler(db)
	}

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
			const now = Date.now()
			const fullSweep = now - this.lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS
			await this.reconciler.selfHealTerminalWithoutEvents(
				now,
				SELF_HEAL_GRACE_MS,
				SELF_HEAL_DEFAULT_LIMIT,
				fullSweep ? SELF_HEAL_LOOKBACK_MS : SELF_HEAL_RECENT_LOOKBACK_MS,
			)
			// Only a pass that finished counts: a failed sweep is retried next tick.
			if (fullSweep) this.lastFullSweepAt = now
		} catch (err) {
			logger.error('Session self-heal tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
