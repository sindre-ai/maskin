import type { Database } from '@maskin/db'
import { events, workspaces } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { trackClaudeSubscriptionRecovered } from './analytics/claude-failover-events'
import {
	type OAuthFailoverState,
	type OAuthSlotData,
	type OAuthSlotKind,
	readChain,
	readFailoverState,
	readSlots,
	slotFailure,
	withSlotFailure,
	writeFailoverState,
} from './claude-oauth-slots'
import { logger } from './logger'

/**
 * AC-U6: after a failover, the next session start must try the head of the
 * chain first AGAIN — but only after ≥5 minutes since that slot last failed.
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
 * Pure cooldown gate. Returns true when the workspace is currently routed to
 * something other than the head of its chain, still has that head slot to go
 * back to, and the cooldown since the head last failed has elapsed.
 */
export function shouldAttemptPrimaryRecovery({
	slots,
	failover,
	now,
	cooldownMs = PRIMARY_RECOVERY_COOLDOWN_MS,
}: ShouldAttemptInput): boolean {
	const head = chainHead(slots)
	if (!head) return false
	if (failover.active_slot === head) return false
	const lastFailure = slotFailure(failover, head).at
	if (typeof lastFailure === 'number' && now - lastFailure < cooldownMs) return false
	return true
}

/**
 * The first slot of the chain given an already-read slot map. Mirrors
 * `readChain(raw)[0]` for callers that hold the map rather than the raw value.
 */
function chainHead(slots: ReturnType<typeof readSlots>): OAuthSlotKind | undefined {
	if (slots.primary) return 'primary'
	if (slots.backup) return 'backup'
	const extras = Object.keys(slots)
		.filter((id) => id !== 'primary' && id !== 'backup' && slots[id])
		.sort()
	return extras[0]
}

export interface AttemptPrimaryRecoveryInput {
	db: Database
	workspaceId: string
	actorId: string
	/** Probes the head of the chain — the slot recovery would switch back to. */
	healthCheck: (head: OAuthSlotData) => Promise<RecoveryHealthCheckResult>
	now?: number
	cooldownMs?: number
}

export type AttemptPrimaryRecoveryResult =
	| { recovered: true; slot: OAuthSlotKind }
	| { recovered: false; reason: 'no_workspace' | 'cooldown' | 'unhealthy'; detail?: string }

/**
 * Lazy switch-back orchestrator. Runs a cheap, lock-free precheck of the
 * cooldown gate, then the caller-supplied `healthCheck` against the HEAD of
 * the slot chain (a live token refresh + subscription probe) OUTSIDE any
 * transaction, then locks the workspace row, re-checks the gate under the
 * lock (state may have changed while the network probe was in flight), and
 * either flips `failover.active_slot` back to the head and emits a
 * `claude_subscription_recovered` event, or records a fresh failure against
 * the head and stays where it is.
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

	// Safe: the gate above guarantees the chain has a head. Runs the live
	// token refresh + subscription probe with no transaction/lock open.
	const precheckHead = readChain(precheckSettings.claude_oauth)[0] as {
		id: OAuthSlotKind
		data: OAuthSlotData
	}
	const probe = await healthCheck(precheckHead.data)

	type TxOutcome =
		| {
				kind: 'recovered'
				slot: OAuthSlotKind
				previousSlot: OAuthSlotKind
				priorFailureAt?: number
				priorFailureReason?: string
		  }
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

		// The head may have changed while the probe was in flight (a slot was
		// disconnected, or a new credential was imported ahead of this one) —
		// re-read it under the lock rather than trusting the precheck.
		const head = readChain(oauthRaw)[0]?.id
		if (!head) {
			return {
				kind: 'noop',
				result: { recovered: false, reason: 'cooldown' as const },
			}
		}
		const priorFailure = slotFailure(failover, head)

		if (probe.healthy) {
			const nextOAuth = writeFailoverState(
				oauthRaw,
				withSlotFailure({ ...failover, active_slot: head }, head, undefined),
			)
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
					previous_active_slot: failover.active_slot,
					recovered_slot: head,
					recovered_at: now,
					prior_failure_at: priorFailure.at,
					prior_failure_reason: priorFailure.reason,
				},
			})

			logger.info('Claude head subscription recovered', { workspaceId, slot: head })
			return {
				kind: 'recovered',
				slot: head,
				previousSlot: failover.active_slot,
				priorFailureAt: priorFailure.at,
				priorFailureReason: priorFailure.reason,
			}
		}

		const nextOAuth = writeFailoverState(
			oauthRaw,
			withSlotFailure(failover, head, { at: now, reason: probe.reason }),
		)
		await tx
			.update(workspaces)
			.set({
				settings: { ...wsSettings, claude_oauth: nextOAuth },
				updatedAt: new Date(now),
			})
			.where(eq(workspaces.id, workspaceId))

		logger.info('Claude head-slot recovery probe failed; staying on the current slot', {
			workspaceId,
			activeSlot: failover.active_slot,
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
		return { recovered: true, slot: outcome.slot }
	}
	return outcome.result
}
