import type { Database } from '@maskin/db'
import { logger } from '../lib/logger'
import { SessionReconciler } from './session-reconciler'

const TICK_MS = 60 * 1000 // 1m, matches SELF_HEAL_GRACE_MS

/**
 * Periodic caller for the §9.4 self-heal check. Every tick back-fills the
 * `session_*` events row for terminal-status sessions that never got one
 * (see SessionReconciler.selfHealTerminalWithoutEvents). Ticks never overlap:
 * a slow pass makes the next tick a no-op instead of stacking queries.
 */
export class SessionSelfHealJob {
	private timer: NodeJS.Timeout | null = null
	private running = false
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
			await this.reconciler.selfHealTerminalWithoutEvents()
		} catch (err) {
			logger.error('Session self-heal tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
