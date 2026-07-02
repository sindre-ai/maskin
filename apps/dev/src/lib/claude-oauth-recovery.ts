import type { Database } from '@maskin/db'
import { events, workspaces } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import {
	type OAuthFailoverState,
	type OAuthSlotData,
	readFailoverState,
	readSlots,
	writeFailoverState,
} from './claude-oauth-slots'
import { logger } from './logger'

/**
 * AC-U6: after a failover, the next session start must try the primary
 * first AGAIN — but only after ≥5 minutes since the last primary failure.
 * Mid-session swap-back is out of scope; only the next session triggers a
 * recovery attempt.
 */
export const PRIMARY_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000

export const CLAUDE_SUBSCRIPTION_RECOVERED = 'claude_subscription_recovered'

export type RecoveryHealthCheckResult = { healthy: true } | { healthy: false; reason: string }

export interface ShouldAttemptInput {
	slots: ReturnType<typeof readSlots>
	failover: OAuthFailoverState
	now: number
	cooldownMs?: number
}

/**
 * Pure cooldown gate. Returns true when the workspace is currently routed
 * to backup, has a primary slot to attempt, and the cooldown since the
 * last primary failure has elapsed.
 */
export function shouldAttemptPrimaryRecovery({
	slots,
	failover,
	now,
	cooldownMs = PRIMARY_RECOVERY_COOLDOWN_MS,
}: ShouldAttemptInput): boolean {
	if (failover.active_slot !== 'backup') return false
	if (!slots.primary) return false
	const lastFailure = failover.last_primary_failure_at
	if (typeof lastFailure === 'number' && now - lastFailure < cooldownMs) return false
	return true
}

export interface AttemptPrimaryRecoveryInput {
	db: Database
	workspaceId: string
	actorId: string
	healthCheck: (primary: OAuthSlotData) => Promise<RecoveryHealthCheckResult>
	now?: number
	cooldownMs?: number
}

export type AttemptPrimaryRecoveryResult =
	| { recovered: true }
	| { recovered: false; reason: 'no_workspace' | 'cooldown' | 'unhealthy'; detail?: string }

/**
 * Lazy switch-back orchestrator. Locks the workspace row in a transaction,
 * re-checks the cooldown gate inside the lock, runs the caller-supplied
 * `healthCheck` against the primary slot, then either flips
 * `failover.active_slot` to `'primary'` and emits a
 * `claude_subscription_recovered` event, or records a fresh
 * `last_primary_failure_at` and stays on backup.
 *
 * Idempotency: the `SELECT … FOR UPDATE` serialises concurrent recovery
 * attempts on the same workspace, so the event fires exactly once per
 * successful recovery window (AC-T2-style concurrency).
 */
export async function attemptPrimaryRecovery(
	input: AttemptPrimaryRecoveryInput,
): Promise<AttemptPrimaryRecoveryResult> {
	const { db, workspaceId, actorId, healthCheck } = input
	const now = input.now ?? Date.now()
	const cooldownMs = input.cooldownMs ?? PRIMARY_RECOVERY_COOLDOWN_MS

	return await db.transaction(async (tx) => {
		const locked = await tx.execute(
			sql`SELECT settings FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`,
		)
		const row = (locked as unknown as { rows?: Array<{ settings: unknown }> }).rows?.[0]
		if (!row) {
			return { recovered: false, reason: 'no_workspace' as const }
		}

		const wsSettings = (row.settings as Record<string, unknown>) ?? {}
		const oauthRaw = wsSettings.claude_oauth
		const slots = readSlots(oauthRaw)
		const failover = readFailoverState(oauthRaw)

		if (!shouldAttemptPrimaryRecovery({ slots, failover, now, cooldownMs })) {
			return { recovered: false, reason: 'cooldown' as const }
		}

		// Safe: gate above guarantees `slots.primary` is defined.
		const primarySlot = slots.primary as OAuthSlotData
		const probe = await healthCheck(primarySlot)

		if (probe.healthy) {
			const nextOAuth = writeFailoverState(oauthRaw, {
				active_slot: 'primary',
				last_primary_failure_at: undefined,
				last_classified_reason: undefined,
			})
			await tx
				.update(workspaces)
				.set({
					settings: { ...wsSettings, claude_oauth: nextOAuth },
					updatedAt: new Date(now),
				})
				.where(eq(workspaces.id, workspaceId))

			await tx.insert(events).values({
				workspaceId,
				actorId,
				action: CLAUDE_SUBSCRIPTION_RECOVERED,
				entityType: 'workspace',
				entityId: workspaceId,
				data: {
					previous_active_slot: 'backup',
					recovered_at: now,
					prior_failure_at: failover.last_primary_failure_at,
					prior_failure_reason: failover.last_classified_reason,
				},
			})

			logger.info('Claude primary subscription recovered', { workspaceId, slot: 'primary' })
			return { recovered: true }
		}

		const nextOAuth = writeFailoverState(oauthRaw, {
			active_slot: 'backup',
			last_primary_failure_at: now,
			last_classified_reason: probe.reason,
		})
		await tx
			.update(workspaces)
			.set({
				settings: { ...wsSettings, claude_oauth: nextOAuth },
				updatedAt: new Date(now),
			})
			.where(eq(workspaces.id, workspaceId))

		logger.info('Claude primary recovery probe failed; staying on backup', {
			workspaceId,
			reason: probe.reason,
		})
		return { recovered: false, reason: 'unhealthy' as const, detail: probe.reason }
	})
}
