import type { Database } from '@maskin/db'
import { oauthAuthorizationCodes, oauthTokens } from '@maskin/db/schema'
import { lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

const TICK_MS = 60 * 60 * 1000 // 1h
const DAY_MS = 24 * 60 * 60 * 1000

/** Codes live 60 seconds; a day past that nothing can still be looking at one. */
export const CODE_RETENTION_MS = DAY_MS
/** Tokens are kept a week past expiry so a late, stale request still reads as expired, not unknown. */
export const TOKEN_RETENTION_MS = 7 * DAY_MS

/**
 * Deletes spent Claude connector codes and tokens. Grants themselves are kept: they are the
 * audit record of who connected what and how it ended. Nothing live is ever touched, because
 * only rows long past their expiry qualify.
 */
export class OAuthSweeper {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(private db: Database) {}

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

	async tick(now: Date = new Date()): Promise<{ codes: number; tokens: number } | null> {
		if (this.running) return null
		this.running = true
		try {
			const codes = await this.db
				.delete(oauthAuthorizationCodes)
				.where(lt(oauthAuthorizationCodes.expiresAt, new Date(now.getTime() - CODE_RETENTION_MS)))
				.returning({ codeHash: oauthAuthorizationCodes.codeHash })
			const tokens = await this.db
				.delete(oauthTokens)
				.where(lt(oauthTokens.expiresAt, new Date(now.getTime() - TOKEN_RETENTION_MS)))
				.returning({ id: oauthTokens.id })
			if (codes.length > 0 || tokens.length > 0) {
				logger.info('OAuth sweeper tick', { codes: codes.length, tokens: tokens.length })
			}
			return { codes: codes.length, tokens: tokens.length }
		} catch (err) {
			logger.error('OAuth sweeper tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return null
		} finally {
			this.running = false
		}
	}
}
