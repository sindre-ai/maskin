import type { StorageProvider } from '@maskin/storage'
import { logger } from '../lib/logger'
import { utcDateStamp } from './spoken-brief'

const TICK_MS = 60 * 60 * 1000 // 1h
const PREFIX = 'briefs/'

/** `briefs/{workspaceId}/{YYYY-MM-DD}.json` */
const BRIEF_KEY_RE = /^briefs\/[^/]+\/(\d{4}-\d{2}-\d{2})\.json$/

/**
 * Deletes yesterday's cached brief scripts.
 *
 * The scripts are a token-saving cache, not a record: a brief is written from
 * the workspace as it stood on one day, so once that day is over the file is
 * only worth storage. Retention is expressed in whole UTC days rather than a
 * duration because the cache key is a date — the sweep and the cache have to
 * agree on where the day ends.
 *
 * Ticks hourly so a workspace in any timezone gets a reasonably prompt sweep
 * after UTC midnight. Deleting a brief costs nothing: the next press of play
 * regenerates it.
 */
export class BriefCacheCleaner {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private storage: StorageProvider,
		/** Days of history to keep, including today. 1 = today only. */
		private retentionDays = 1,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), TICK_MS)
		setTimeout(() => this.tick(), 60_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	async tick(now: Date = new Date()): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const cutoff = utcDateStamp(
				new Date(now.getTime() - (this.retentionDays - 1) * 24 * 60 * 60 * 1000),
			)
			const keys = await this.storage.list(PREFIX)
			let deleted = 0
			for (const key of keys) {
				const stamp = key.match(BRIEF_KEY_RE)?.[1]
				// Anything that isn't a dated brief file is not ours to delete.
				if (!stamp) continue
				// Lexicographic comparison is date comparison for ISO stamps.
				if (stamp >= cutoff) continue
				try {
					await this.storage.delete(key)
					deleted += 1
				} catch (err) {
					logger.warn('Failed to delete expired brief', { key, error: String(err) })
				}
			}
			if (deleted > 0) {
				logger.info('Brief cache cleaner tick', { deleted, cutoff })
			}
		} catch (err) {
			logger.error('Brief cache cleaner tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
