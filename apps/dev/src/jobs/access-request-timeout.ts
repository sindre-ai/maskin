import type { Database } from '@maskin/db'
import { Cron } from 'croner'
import { logger } from '../lib/logger'
import { sweepAccessRequestTimeouts } from '../services/access-request-flow'
import type { SessionManager } from '../services/session-manager'

/**
 * Closes access requests nobody answered within the hour. Each one ends expired with
 * no grant, starts the 24 hour cooldown for that agent and credential, lands on the
 * audit chain as a grant_denied row and goes to a human (see sweepAccessRequestTimeouts).
 * Idempotent: a closed request is no longer open, so a second run finds nothing.
 *
 * Scheduler: croner, every minute, so a request is closed within a minute of its hour.
 */
const CRON_EXPRESSION = '* * * * *'

export class AccessRequestTimeoutJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private sessionManager: SessionManager,
		private cronExpression: string = CRON_EXPRESSION,
	) {}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	/** Returns the number of requests closed. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const closed = await sweepAccessRequestTimeouts({
				db: this.db,
				sessionManager: this.sessionManager,
			})
			if (closed > 0) logger.info('Access request timeout tick', { requests_closed: closed })
			return closed
		} catch (err) {
			logger.error('Access request timeout tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return 0
		} finally {
			this.running = false
		}
	}
}
