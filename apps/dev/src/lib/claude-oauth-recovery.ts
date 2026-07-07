import type { Database } from '@maskin/db'
import { events, workspaces } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { trackClaudeSubscriptionRecovered } from './analytics/claude-failover-events'
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
 * Lazy switch-back orchestrator. Runs a cheap, lock-free precheck of the
 * cooldown gate, then the caller-supplied `healthCheck` against the primary
 * slot (a live token refresh + subscription probe) OUTSIDE any transaction,
 * then locks the workspace row, re-checks the gate under the lock (state may
 * have changed while the network probe was in flight), and either flips
 * `failover.active_slot` to `'primary'` and emits a
 * `claude_subscription_recovered` event, or records a fresh
 * `last_primary_failure_at` and stays on backup.
 *
 * The row lock must never span the network probe: this fires on the exact
 * path where the primary is already degraded (most likely to be slow), and
 * holding `FOR UPDATE` across it would block every other concurrent writer
 * to the row (session starts, token refreshes, runtime-failure recording)
 * for the full probe duration. See the network-refresh-before-lock pattern
 * in `persistRefreshedSlot` (claude-oauth.ts) and `resolveClaudeCredentialsWithFailover`.
 *
 * Idempotency: the double-checked gate (precheck, then re-checked under the
 * `SELECT … FOR UPDATE` lock) means only the caller that wins the lock while
 * the gate still holds gets to write, so the event fires exactly once per
 * successful recovery window (AC-T2-style concurrency) even though the
 * network probe itself may run redundantly for a losing concurrent caller.
 */
export async function attemptPrimaryRecovery(
	input: AttemptPrimaryRecoveryInput,
): Promise<AttemptPrimaryRecoveryResult> {
	const { db, workspaceId, actorId, healthCheck } = input
	const now = input.now ?? Date.now()
	const cooldownMs = input.cooldownMs ?? PRIMARY_RECOVERY_COOLDOWN_MS

	const precheckRows = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	const precheckRow = precheckRows[0]
	if (!precheckRow) {
		return { recovered: false, reason: 'no_workspace' as const }
	}
	const precheckSettings = (precheckRow.settings as Record<string, unknown>) ?? {}
	const precheckSlots = readSlots(precheckSettings.claude_oauth)
	const precheckFailover = readFailoverState(precheckSettings.claude_oauth)
	if (
		!shouldAttemptPrimaryRecovery({
			slots: precheckSlots,
			failover: precheckFailover,
			now,
			cooldownMs,
		})
	) {
		return { recovered: false, reason: 'cooldown' as const }
	}

	// Safe: gate above guarantees `slots.primary` is defined. Runs the live
	// token refresh + subscription probe with no transaction/lock open.
	const probe = await healthCheck(precheckSlots.primary as OAuthSlotData)

	type TxOutcome =
		| { kind: 'recovered'; priorFailureAt?: number; priorFailureReason?: string }
		| { kind: 'noop'; result: AttemptPrimaryRecoveryResult }

	const outcome: TxOutcome = await db.transaction(async (tx) => {
		// drizzle-orm/postgres-js's `.execute()` returns the row list directly
		// (no `{ rows: [...] }` wrapper — that shape is node-postgres/`pg`
		// specific). See the established cast pattern in routes/sessions.ts.
		const locked = (await tx.execute(
			sql`SELECT settings FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`,
		)) as unknown as Array<{ settings: unknown }>
		const row = locked[0]
		if (!row) {
			return {
				kind: 'noop',
				result: { recovered: false, reason: 'no_workspace' as const },
			}
		}

		const wsSettings = (row.settings as Record<string, unknown>) ?? {}
		const oauthRaw = wsSettings.claude_oauth
		const slots = readSlots(oauthRaw)
		const failover = readFailoverState(oauthRaw)

		// Re-check under the lock: another concurrent recovery attempt may have
		// already recorded a result (or the primary slot may have been
		// disconnected) while this call's healthCheck was in flight above.
		if (!shouldAttemptPrimaryRecovery({ slots, failover, now, cooldownMs })) {
			return {
				kind: 'noop',
				result: { recovered: false, reason: 'cooldown' as const },
			}
		}

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
			return {
				kind: 'recovered',
				priorFailureAt: failover.last_primary_failure_at,
				priorFailureReason: failover.last_classified_reason,
			}
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
		return {
			kind: 'noop',
			result: { recovered: false, reason: 'unhealthy' as const, detail: probe.reason },
		}
	})

	if (outcome.kind === 'recovered') {
		// PostHog forwarding — runs after the tx commits so the workspace row
		// lock isn't held across the network fetch. Losing concurrent
		// contenders take the `noop`/`cooldown` branch above, so this fires
		// exactly once per successful recovery.
		await trackClaudeSubscriptionRecovered({
			workspaceId,
			actorId,
			recoveredAt: now,
			priorFailureAt: outcome.priorFailureAt,
			priorFailureReason: outcome.priorFailureReason,
		})
		return { recovered: true }
	}
	return outcome.result
}
