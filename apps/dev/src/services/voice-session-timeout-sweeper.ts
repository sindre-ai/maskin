import type { Database } from '@maskin/db'
import { voiceSessions } from '@maskin/db/schema'
import { and, inArray, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { endVoiceSession } from './voice-session-lifecycle'

const TICK_MS = 60 * 1000

/**
 * Idle-timeout sweeper for Voice v1 (tech spec §Session lifecycle). Every
 * transcript line written pushes voice_sessions.timeout_at forward; a call
 * that goes quiet (tab closed with no hangup, laptop lid shut) stops bumping
 * it, and this loop ends the row as timed_out once the deadline passes.
 * Idempotent: endVoiceSession only matches rows still pending / active, so a
 * row a hangup already closed is skipped, and overlapping ticks cannot double
 * fire voice_session_ended.
 */
export class VoiceSessionTimeoutSweeper {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private tickMs: number = TICK_MS,
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

	/** Returns how many calls this tick ended. */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const expired = await this.db
				.select({ id: voiceSessions.id })
				.from(voiceSessions)
				.where(
					and(
						inArray(voiceSessions.status, ['pending', 'active']),
						lt(voiceSessions.timeoutAt, now),
					),
				)
			let ended = 0
			for (const { id } of expired) {
				try {
					if (await endVoiceSession(this.db, { id, reason: 'idle_timeout' })) ended++
				} catch (err) {
					logger.error('Voice session timeout sweep failed for one session', {
						voice_session_id: id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			if (ended > 0) logger.info('Voice session timeout sweeper tick', { ended })
			return ended
		} catch (err) {
			logger.error('Voice session timeout sweeper tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return 0
		} finally {
			this.running = false
		}
	}
}

/** Ends every live call. Used on shutdown so a deploy does not leave rows live until the sweeper finds them. */
export async function endAllLiveVoiceSessions(db: Database): Promise<void> {
	const live = await db
		.select({ id: voiceSessions.id })
		.from(voiceSessions)
		.where(inArray(voiceSessions.status, ['pending', 'active']))
	for (const { id } of live) {
		await endVoiceSession(db, { id, reason: 'server_stop' }).catch((err) =>
			logger.error('Voice session server_stop end failed', {
				voice_session_id: id,
				error: err instanceof Error ? err.message : String(err),
			}),
		)
	}
}
