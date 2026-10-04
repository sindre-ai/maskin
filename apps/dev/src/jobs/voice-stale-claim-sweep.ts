import { z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { Cron } from 'croner'
import { logger } from '../lib/logger'
import { createDefaultEffectRunner } from '../lib/outreach/voice/effects'
import { createDrizzleStaleClaimStore } from '../lib/outreach/voice/stale-claim-store'
import {
	type StaleClaimDeps,
	readStaleClaimMinutes,
	runStaleClaimSweep,
} from '../lib/outreach/voice/stale-claim-sweep'

/**
 * Voice stale-claim sweep cron: once a minute, all day. Its own step rather than
 * part of the per-workspace dial tick, because that tick returns outside the
 * 09:00-16:00 dial window and only visits workspaces with a due contact, so a
 * workspace holding only stuck voice_dialing rows would never be swept. Registered
 * unconditionally, the same in-process shape as voice-dialer.ts. It places no
 * call, so it is not behind VOICE_OUTREACH_AUTOSEND; with no voice_dialing
 * contact a run costs one indexed query. Guarded against overlapping runs.
 */
const CRON_EXPRESSION = '0 * * * * *'

const actorIdSchema = z.string().uuid()

export class VoiceStaleClaimSweepJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private env: NodeJS.ProcessEnv = process.env,
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

	async tick(now: Date = new Date()): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			await runStaleClaimSweep({ ...this.deps(), now: () => now })
		} catch (err) {
			logger.error('Voice stale-claim sweep failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}

	private deps(): StaleClaimDeps {
		const actor = actorIdSchema.safeParse(this.env.VOICE_SALES_REP_ACTOR_ID ?? '')
		const runner = createDefaultEffectRunner(this.db)
		return {
			store: createDrizzleStaleClaimStore(this.db),
			thresholdMinutes: readStaleClaimMinutes(this.env),
			actorId: actor.success ? actor.data : null,
			deadLetter: (ctx, reason) => runner.deadLetter(reason, ctx),
		}
	}
}
