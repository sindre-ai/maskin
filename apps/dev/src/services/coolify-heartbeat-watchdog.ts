import type { Database } from '@maskin/db'
import { events, integrations, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'

const TICK_MS = 30 * 60 * 1000 // 30m — silence is measured in hours, polling every 30m is plenty
const SILENCE_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24h, per AC-T7
const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000 // don't re-alert the same integration more than once per 24h

/**
 * AC-T7: emit an urgent workspace insight when an active Coolify integration
 * has gone >24h without delivering any webhook. The webhook route bumps
 * `integration.config.last_event_at` on every accepted delivery; this loop
 * compares that against the silence threshold and fires the insight.
 *
 * Self-throttled via `integration.config.last_silence_alerted_at` so a
 * permanently silent integration doesn't generate a fresh insight on every tick.
 */
export class CoolifyHeartbeatWatchdog {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private silenceThresholdMs: number = SILENCE_THRESHOLD_MS,
		private alertRepeatMs: number = ALERT_REPEAT_MS,
		private tickMs: number = TICK_MS,
	) {}

	start(): void {
		if (this.timer) return
		// Run once shortly after boot so a freshly-restarted server doesn't sit on
		// a stale silence for the whole tick interval.
		setTimeout(() => this.tick(), 60_000).unref()
		this.timer = setInterval(() => this.tick(), this.tickMs)
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	async tick(): Promise<void> {
		if (!isEnabled()) return
		if (this.running) return
		this.running = true
		try {
			const now = Date.now()
			const rows = await this.db
				.select()
				.from(integrations)
				.where(and(eq(integrations.provider, 'coolify'), eq(integrations.status, 'active')))

			let alerted = 0
			for (const integration of rows) {
				const config = (integration.config as Record<string, unknown> | null) ?? {}
				const lastEventAtRaw = config.last_event_at
				const lastAlertedRaw = config.last_silence_alerted_at

				// Reference point for "silent for X hours" is whichever of (last received
				// webhook, integration creation) is more recent — a brand-new integration
				// that's never received an event shouldn't immediately trip the watchdog.
				const lastEventAt =
					typeof lastEventAtRaw === 'string' && lastEventAtRaw
						? Date.parse(lastEventAtRaw)
						: integration.createdAt
							? new Date(integration.createdAt).getTime()
							: now
				const silenceMs = now - lastEventAt
				if (silenceMs < this.silenceThresholdMs) continue

				const lastAlertedAt =
					typeof lastAlertedRaw === 'string' && lastAlertedRaw ? Date.parse(lastAlertedRaw) : 0
				if (now - lastAlertedAt < this.alertRepeatMs) continue

				try {
					await this.emitSilenceInsight(integration, silenceMs, now, config)
					alerted += 1
				} catch (err) {
					logger.error('Coolify heartbeat watchdog failed to emit silence insight', {
						workspaceId: integration.workspaceId,
						integrationId: integration.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			if (alerted > 0) {
				logger.warn('Coolify heartbeat watchdog raised silence insights', {
					integrations_checked: rows.length,
					silence_insights_created: alerted,
				})
			}
		} catch (err) {
			logger.error('Coolify heartbeat watchdog tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}

	private async emitSilenceInsight(
		integration: { id: string; workspaceId: string; createdBy: string },
		silenceMs: number,
		now: number,
		existingConfig: Record<string, unknown>,
	): Promise<void> {
		const hours = Math.floor(silenceMs / (60 * 60 * 1000))
		const fingerprint = `coolify_silence:${integration.id}`
		const content = [
			'**Coolify webhook integration has gone silent.**',
			'',
			`No deployment / crash / health webhook has reached Maskin in **~${hours}h**. The integration is still marked active — Coolify itself may be down, the webhook URL may be misrouted, or the signing secret may have drifted.`,
			'',
			'Verify in this order:',
			'- Coolify dashboard → notifications → confirm the Maskin webhook is enabled.',
			'- Tail server logs for any rejected `coolify_signature_invalid` entries.',
			'- Force a test webhook from Coolify and confirm an insight appears.',
		].join('\n')

		await this.db.transaction(async (tx) => {
			const [row] = await tx
				.insert(objects)
				.values({
					workspaceId: integration.workspaceId,
					type: 'insight',
					title: 'Coolify webhook integration appears silent (>24h)',
					content,
					status: 'new',
					createdBy: integration.createdBy,
					metadata: {
						urgent: true,
						source: 'coolify_silence',
						fingerprint,
						integration_id: integration.id,
						kind: 'silence_alert',
						silence_hours: hours,
						received_at: new Date(now).toISOString(),
					},
				})
				.returning({ id: objects.id })

			if (row) {
				await tx.insert(events).values({
					workspaceId: integration.workspaceId,
					actorId: integration.createdBy,
					action: 'created',
					entityType: 'object',
					entityId: row.id,
					data: { source: 'coolify_silence', fingerprint, urgent: true, silence_hours: hours },
				})
			}

			await tx
				.update(integrations)
				.set({
					config: { ...existingConfig, last_silence_alerted_at: new Date(now).toISOString() },
					updatedAt: new Date(now),
				})
				.where(eq(integrations.id, integration.id))
		})

		logger.info('Coolify silence insight emitted', {
			workspaceId: integration.workspaceId,
			integrationId: integration.id,
			silence_hours: hours,
		})
	}
}

function isEnabled(): boolean {
	const raw = process.env.COOLIFY_OBSERVABILITY_ENABLED
	if (!raw) return false
	return raw === '1' || raw.toLowerCase() === 'true'
}
