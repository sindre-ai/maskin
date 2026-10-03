import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { Cron } from 'croner'
import { eq } from 'drizzle-orm'
import { FLAGS, isFlagEnabledForWorkspace } from '../lib/feature-flags'
import { createTelnyxClient } from '../lib/integrations/providers/telnyx/client'
import { readTelnyxRuntimeConfig } from '../lib/integrations/providers/telnyx/config'
import { logger } from '../lib/logger'
import { type DialerDeps, runDialerTick } from '../lib/outreach/voice/dialer'
import {
	createDrizzleDialerStore,
	findWorkspacesWithDueContacts,
} from '../lib/outreach/voice/dialer-store'
import {
	type FounderActors,
	inDialWindow,
	parseFounderActors,
} from '../lib/outreach/voice/dnc-gate'
import { WorkspaceRobinsonLists } from '../lib/outreach/voice/robinson-list'

/**
 * Voice dialer cron: a tick about every 10 seconds, and only inside the
 * Europe/Copenhagen 09:00-16:00 workday window. Registered unconditionally, the
 * same in-process shape as purge-idempotency.ts and vies-scheduler.ts. Only the
 * dial action is behind the VOICE_OUTREACH_AUTOSEND flag; with it off a tick
 * builds the queue and records a ready-to-dial summary.
 *
 * A tick runs for each workspace that has a due contact, so a workspace with
 * nothing to dial costs one indexed query and writes nothing. Guarded against
 * overlapping runs: a slow tick (Telnyx retrying) never doubles up with the next.
 */
const CRON_EXPRESSION = '*/10 * * * * *'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function str(v: string | undefined): string | null {
	return v && v.trim() !== '' ? v.trim() : null
}

export class VoiceDialerJob {
	private job: Cron | null = null
	private running = false
	private founders: FounderActors
	private robinson: WorkspaceRobinsonLists

	constructor(
		private db: Database,
		storage: Pick<StorageProvider, 'get'>,
		private env: NodeJS.ProcessEnv = process.env,
		private cronExpression: string = CRON_EXPRESSION,
	) {
		// Parsed once. An empty or invalid map fails every owner check closed.
		this.founders = parseFounderActors(env.VOICE_FOUNDER_ACTORS)
		if (!this.founders.ok) {
			logger.warn('voice dialer: founder rule will refuse every contact', {
				reason: this.founders.reason,
			})
		}
		this.robinson = new WorkspaceRobinsonLists(db, storage)
	}

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
			if (!inDialWindow(now)) return
			for (const workspaceId of await findWorkspacesWithDueContacts(this.db, now)) {
				try {
					await runDialerTick(workspaceId, this.depsFor(workspaceId))
				} catch (err) {
					logger.error('Voice dialer tick failed', {
						workspaceId,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
		} catch (err) {
			logger.error('Voice dialer sweep failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}

	private depsFor(workspaceId: string): DialerDeps {
		const runtime = readTelnyxRuntimeConfig(this.env)
		const actorId = UUID.test(this.env.VOICE_SALES_REP_ACTOR_ID ?? '')
			? (this.env.VOICE_SALES_REP_ACTOR_ID as string)
			: null
		const publicUrl = str(this.env.MASKIN_PUBLIC_URL)?.replace(/\/$/, '')
		return {
			store: createDrizzleDialerStore(this.db),
			// No retry callback: the reducer's rest_failure effect writes the one dead letter.
			telnyx: createTelnyxClient({ apiKey: runtime.apiKey ?? '', baseUrl: runtime.apiBaseUrl }),
			gate: {
				founders: this.founders,
				findActor: async (id) => {
					const [row] = await this.db
						.select({ type: actors.type })
						.from(actors)
						.where(eq(actors.id, id))
						.limit(1)
					return row ?? null
				},
				robinson: this.robinson.forWorkspace(workspaceId),
			},
			config: {
				rateLimitPerMinute: runtime.callRateLimitPerMinute,
				dailyCap: runtime.callDailyCap,
				// Without an API key nothing can be dialed; a null here reports telnyx_not_configured.
				fromNumber: runtime.apiKey ? str(this.env.TELNYX_FROM_NUMBER) : null,
				assistantId: runtime.assistantId,
				connectionId: runtime.appId,
				webhookUrl: publicUrl ? `${publicUrl}/api/integrations/telnyx/webhook` : null,
			},
			autosendEnabled: isFlagEnabledForWorkspace(workspaceId, FLAGS.VOICE_OUTREACH_AUTOSEND, {
				actorId: actorId ?? undefined,
			}),
			actorId,
		}
	}
}
