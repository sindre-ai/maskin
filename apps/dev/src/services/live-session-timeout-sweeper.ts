import type { Database } from '@maskin/db'
import { liveSessions } from '@maskin/db/schema'
import { and, inArray, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { endLiveSession } from './live-session-lifecycle'

const TICK_MS = 60 * 1000
/** A tick that has not finished by now is abandoned so the loop cannot stay pinned. */
const TICK_TIMEOUT_MS = 30 * 1000

/**
 * Idle-timeout sweeper. Every finished turn pushes live_sessions.timeout_at
 * forward; a call that goes quiet (app killed, phone dead) stops bumping it and
 * this loop ends the row as timed_out once the deadline passes. Idempotent:
 * endLiveSession only matches rows still live.
 *
 * The tick races a timer and releases its re-entrancy flag when the timer wins.
 * Without that, one query hung on a dead pooler connection would pin `running`
 * true and silently stop the sweep for every workspace (see the re-entrancy
 * entry in .claude/rules/known-pitfalls.md).
 */
export class LiveSessionTimeoutSweeper {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private tickMs: number = TICK_MS,
		private tickTimeoutMs: number = TICK_TIMEOUT_MS,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => void this.tick(), this.tickMs)
		this.timer.unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Returns how many calls this tick ended (0 when skipped or abandoned). */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		this.running = true
		let timeout: NodeJS.Timeout | undefined
		try {
			const work = this.sweep(now)
			const abandoned = new Promise<number>((resolve) => {
				timeout = setTimeout(() => {
					logger.error('Live session sweeper tick abandoned after timeout', {
						timeout_ms: this.tickTimeoutMs,
					})
					work.catch(() => {}) // the hung promise continues detached; swallow its rejection
					resolve(0)
				}, this.tickTimeoutMs)
			})
			return await Promise.race([work, abandoned])
		} finally {
			if (timeout) clearTimeout(timeout)
			this.running = false
		}
	}

	private async sweep(now: Date): Promise<number> {
		try {
			const expired = await this.db
				.select({ id: liveSessions.id })
				.from(liveSessions)
				.where(
					and(inArray(liveSessions.status, ['pending', 'active']), lt(liveSessions.timeoutAt, now)),
				)
			let ended = 0
			for (const { id } of expired) {
				try {
					if (await endLiveSession(this.db, { id, reason: 'idle_timeout' })) ended++
				} catch (err) {
					logger.error('Live session timeout sweep failed for one session', {
						live_session_id: id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			if (ended > 0) logger.info('Live session timeout sweeper tick', { ended })
			return ended
		} catch (err) {
			logger.error('Live session timeout sweeper tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return 0
		}
	}
}

/** Ends every live call. Used on shutdown so a deploy does not leave rows live until the sweeper finds them. */
export async function endAllLiveSessions(db: Database): Promise<void> {
	const live = await db
		.select({ id: liveSessions.id })
		.from(liveSessions)
		.where(inArray(liveSessions.status, ['pending', 'active']))
	for (const { id } of live) {
		await endLiveSession(db, { id, reason: 'server_stop' }).catch((err) =>
			logger.error('Live session server_stop end failed', {
				live_session_id: id,
				error: err instanceof Error ? err.message : String(err),
			}),
		)
	}
}
