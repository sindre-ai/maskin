import type { Database } from '@maskin/db'
import { events, workspaces } from '@maskin/db/schema'
import { CLAUDE_MESSAGES_URL } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import {
	trackClaudeSubscriptionBackupExhausted,
	trackClaudeSubscriptionFailoverTriggered,
} from './analytics/claude-failover-events'
import {
	type ClassifierInput,
	classifyClaudeFailure,
	headersFrom,
} from './claude-failure-classifier'
import {
	CLAUDE_CREDENTIAL_TIMEOUT_MS,
	type ClaudeOAuthTokens,
	type EncryptedOAuthData,
	decryptOAuthData,
	encryptOAuthTokens,
	persistRefreshedSlot,
	refreshClaudeTokenIfNeeded,
} from './claude-oauth'
import { attemptPrimaryRecovery, shouldAttemptPrimaryRecovery } from './claude-oauth-recovery'
import {
	type OAuthSlotKind,
	nextSlotAfter,
	readChain,
	readFailoverState,
	readSlots,
	slotFailure,
	withSlotFailure,
	writeFailoverState,
} from './claude-oauth-slots'
import { logger } from './logger'

/**
 * De-dup window (ms) for the `claude_subscription_failover_triggered` event.
 * Two concurrent sessions failing over on the same classified reason inside
 * the same bucket emit exactly one event (AC-T2). Persisted on
 * `failover.last_primary_failure_at` as the bucket-aligned timestamp.
 */
const FAILURE_WINDOW_BUCKET_MS = 60_000

/**
 * Runtime kill-switch for Claude subscription failover. Default is ON: only the
 * literal string `false` disables it, so a fresh preview, a dev restart, or a
 * new service missing the `turbo.json` passthrough still fails over instead of
 * silently regressing to primary-only. Keep the switch because a classifier
 * misdiagnosis could thrash a workspace through its chain on a bad signal —
 * flipping this to `false` at runtime restores the legacy path without a code
 * roll.
 */
export const CLAUDE_FAILOVER_FLAG_ENV = 'MASKIN_CLAUDE_FAILOVER_ENABLED'

/** Emitted on the workspace when one slot fails over to the next in the chain. */
export const FAILOVER_TRIGGERED_ACTION = 'claude_subscription_failover_triggered'

/**
 * Emitted when the LAST subscription in the chain also rejects a session —
 * there is nothing left to fall over to. Named `backup_exhausted` from when
 * the chain was exactly two slots long; the action string is kept so the
 * existing analytics and alerting keep matching.
 */
export const BACKUP_EXHAUSTED_ACTION = 'claude_subscription_backup_exhausted'

export interface ClaudeCredentials {
	slot: OAuthSlotKind
	tokens: ClaudeOAuthTokens
}

/**
 * Probe called against the primary token before session start. Returns
 * `null` on success (2xx), or a `ClassifierInput` describing the failure
 * so `classifyClaudeFailure` can decide failover vs retry-primary.
 *
 * Injectable so tests can stub each of AC-T3's five HTTP fixtures without
 * standing up a real Anthropic mock server; `resolveClaudeCredentialsWithFailover`
 * falls back to `probeClaudeSubscription` (the real Anthropic Messages API
 * probe) below whenever no `probe` override is passed in.
 */
export type SubscriptionProbe = (tokens: ClaudeOAuthTokens) => Promise<ClassifierInput | null>

/**
 * Default production probe: a minimal (max_tokens: 1) Messages API call
 * authenticated with the primary OAuth access token, so session start can
 * detect a dead subscription (revoked auth, exhausted quota, 5xx) before the
 * container launches. `null` on 2xx; otherwise the response status/headers
 * are handed to `classifyClaudeFailure`. Network-level failures (DNS, abort,
 * etc.) are caught by `runProbe`'s wrapper, not here.
 */
export async function probeClaudeSubscription(
	tokens: ClaudeOAuthTokens,
): Promise<ClassifierInput | null> {
	const res = await fetch(CLAUDE_MESSAGES_URL, {
		method: 'POST',
		// Bounded so a hung Anthropic socket can't stall session launch — see
		// CLAUDE_CREDENTIAL_TIMEOUT_MS. An abort surfaces through `runProbe`'s
		// catch as a transport error, which classifies as retry_primary.
		signal: AbortSignal.timeout(CLAUDE_CREDENTIAL_TIMEOUT_MS),
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${tokens.accessToken}`,
			'anthropic-version': '2023-06-01',
			'anthropic-beta': 'oauth-2025-04-20',
		},
		body: JSON.stringify({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 1,
			messages: [{ role: 'user', content: 'ping' }],
		}),
	})

	if (res.ok) return null

	const headerRecord: Record<string, string> = {}
	res.headers.forEach((value, key) => {
		headerRecord[key] = value
	})
	return { kind: 'http', status: res.status, headers: headersFrom(headerRecord) }
}

/**
 * Why `resolveClaudeCredentialsWithFailover` returned `null` for a workspace
 * that DOES have a slot configured.
 *
 * `transient: true` means the credential may well be fine and we simply could
 * not confirm it — our own socket timed out, the token endpoint returned 5xx.
 * Those must stay retryable: hard-failing a session on one tells the user to
 * reconnect a subscription that was never broken, and removes the backoff that
 * would have recovered on its own. `transient: false` is an auth-class verdict
 * (revoked, exhausted) that repeats identically on every attempt.
 */
export interface UnusableCredentialInfo {
	transient: boolean
	detail: string
}

export interface FailoverParams {
	db: Database
	workspaceId: string
	actorId: string
	/** Overrides the default `probeClaudeSubscription` probe (used by tests). */
	probe?: SubscriptionProbe
	/** Overrides `Date.now` (used by tests). */
	now?: () => number
	/** Overrides `process.env` (used by tests). */
	env?: NodeJS.ProcessEnv
	/** Passed through to `refreshClaudeTokenIfNeeded`. */
	bufferMs?: number
	/**
	 * Invoked when a CONFIGURED slot yields no usable token, reporting whether
	 * the failure is worth retrying. Deliberately not called when nothing is
	 * configured — that is "route absent", not "route broken".
	 */
	onUnusable?: (info: UnusableCredentialInfo) => void
}

export function isClaudeFailoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env[CLAUDE_FAILOVER_FLAG_ENV] ?? '').trim().toLowerCase() !== 'false'
}

/**
 * Session-start entry point for Claude subscription credentials.
 *
 * Flag off (kill-switch flipped to `false`): always primary-only, regardless
 * of whatever `active_slot` a prior (flag-on) failover may have persisted —
 * reads the primary slot directly rather than through the slot resolver, so
 * flipping the kill-switch as an incident lever actually forces routing back
 * to primary instead of silently continuing to serve backup. No probe, no
 * event, no state write. Returns `null` when nothing is configured or the
 * primary can't be refreshed.
 *
 * Flag on: reads the slot chain (`primary`, `backup`, then any further
 * `slot_N` credentials, in that order) and the failover state, then walks
 * FORWARD from the active slot. Each slot is refreshed and probed; the first
 * one that answers healthily is returned. A `failover` verdict from T4's
 * classifier advances to the next slot in the chain, flipping `active_slot`
 * and emitting `claude_subscription_failover_triggered` under one
 * `db.transaction` + `SELECT … FOR UPDATE` on the workspaces row; the
 * failure-window bucket (60s) + classified reason form the de-dup key so a
 * second concurrent session in the same window sees the same bucket+reason
 * under the lock and skips the insert (AC-T2).
 *
 * Two end-of-chain cases, deliberately different:
 *   - the ONLY configured slot fails (AC-U4) → its tokens are returned
 *     unchanged, so the caller (session container) keeps today's hard-failure
 *     behaviour rather than silently falling through to another LLM route.
 *   - the LAST slot of a chain of two or more fails → the chain really is
 *     exhausted, so `claude_subscription_backup_exhausted` is recorded and
 *     `null` returned, letting llm-routing fall through.
 *
 * A `retry_primary` (transient) verdict never advances the chain — that is
 * the classifier's whole point — so a network blip against one subscription
 * doesn't burn through everything the workspace has connected.
 *
 * When the active slot is not the head of the chain, T7's lazy recovery
 * (`attemptPrimaryRecovery`) is attempted first, once the cooldown has
 * elapsed (AC-U6).
 */
export async function resolveClaudeCredentialsWithFailover(
	params: FailoverParams,
): Promise<ClaudeCredentials | null> {
	const { db, workspaceId, actorId, bufferMs, onUnusable } = params
	const probe = params.probe ?? probeClaudeSubscription
	const env = params.env ?? process.env
	const now = params.now ?? Date.now

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) return null

	const wsSettings = (ws.settings as Record<string, unknown>) ?? {}
	const slots = readSlots(wsSettings.claude_oauth)

	if (!isClaudeFailoverEnabled(env)) {
		if (!slots.primary) return null
		const { tokens, refreshFailure } = await loadAndRefreshSlot(
			db,
			workspaceId,
			'primary',
			slots.primary,
			bufferMs,
		)
		if (refreshFailure) {
			// A transient refresh error (network blip, 5xx from the token
			// endpoint) is safe to swallow as long as the pre-refresh token
			// hasn't actually expired yet. A permanently-dead credential
			// (revoked refresh token -> auth_failed) is not -- handing it back
			// as "success" would launch a doomed session and skip the
			// workspace API key / system fallback routes llm-routing would
			// otherwise fall through to. Classify it the same way the
			// flag-on path does below instead of only checking expiry.
			const decision = classifyClaudeFailure(refreshFailure)
			if (decision.action === 'failover' || tokens.expiresAt <= now()) {
				onUnusable?.(unusableFromRefresh(decision))
				return null
			}
		}
		return { slot: 'primary', tokens }
	}

	const chain = readChain(wsSettings.claude_oauth)
	if (chain.length === 0) return null
	const failover = readFailoverState(wsSettings.claude_oauth)

	let startIndex = chain.findIndex((entry) => entry.id === failover.active_slot)
	// A dangling `active_slot` (the slot it names was disconnected without the
	// pointer being repointed) reads as "no credentials", as it did before the
	// chain generalised — the disconnect route repoints, so this is only
	// reachable through a hand-edited row.
	if (startIndex < 0) return null

	// AC-U6: once we've moved off the head of the chain, the next session start
	// tries the head again — but only after the cooldown since its last failure.
	if (startIndex > 0 && shouldAttemptPrimaryRecovery({ slots, failover, now: now() })) {
		const recovered = await attemptChainHeadRecovery({
			db,
			workspaceId,
			actorId,
			probe,
			bufferMs,
			now: now(),
		})
		if (recovered) return recovered
		// The head is still unhealthy; carry on from where we were.
		startIndex = chain.findIndex((entry) => entry.id === failover.active_slot)
		if (startIndex < 0) return null
	}

	// Why the previous slot in the chain was abandoned — carried into the
	// transition record written when we move onto the next one.
	let lastReason: string | undefined

	for (const [index, entry] of chain.entries()) {
		if (index < startIndex) continue
		const isLast = index === chain.length - 1
		const previous = chain[index - 1]

		if (previous && index > startIndex) {
			// Moving to this slot is itself the failover transition — record it
			// (and its event) before we spend a network round trip on it.
			await recordFailoverTransition({
				db,
				workspaceId,
				actorId,
				fromSlot: previous.id,
				toSlot: entry.id,
				bucket: Math.floor(now() / FAILURE_WINDOW_BUCKET_MS) * FAILURE_WINDOW_BUCKET_MS,
				reason: lastReason ?? 'unknown',
			})
		}

		const { tokens, refreshFailure } = await loadAndRefreshSlot(
			db,
			workspaceId,
			entry.id,
			entry.data,
			bufferMs,
		)
		const probeInput: ClassifierInput | null = refreshFailure ?? (await runProbe(probe, tokens))
		if (!probeInput) {
			// This slot answered healthily. If it was carrying a failure record
			// from an earlier session, drop it — otherwise the settings page
			// would keep reporting a credential as unhealthy long after it
			// recovered, since nothing else clears a record for a slot that is
			// already the active one.
			await clearSlotFailureRecord(db, workspaceId, entry.id)
			return { slot: entry.id, tokens }
		}

		const decision = classifyClaudeFailure(probeInput)
		if (decision.action === 'retry_primary') {
			if (refreshFailure && tokens.expiresAt <= now()) {
				// The refresh itself failed transiently (network/5xx) AND the
				// fallback token is actually expired — not just inside the
				// proactive refresh buffer. Handing it back as "success" would
				// launch a session with dead credentials and never reach the
				// workspace API key / system fallback routes. Signal unusable so
				// the caller (llm-routing) falls through instead.
				onUnusable?.(unusableFromRefresh(decision))
				return null
			}
			// Transient: this slot is presumed fine, and burning the rest of the
			// chain on a blip is exactly what the classifier exists to prevent.
			return { slot: entry.id, tokens }
		}

		// decision.action === 'failover' — AC-U2 / AC-T3.
		if (isLast) {
			if (chain.length === 1) {
				// AC-U4: a lone credential → no silent fallback to nothing.
				return { slot: entry.id, tokens }
			}
			await recordChainExhausted({
				db,
				workspaceId,
				actorId,
				slot: entry.id,
				reason: decision.reason,
				now: now(),
			})
			onUnusable?.({
				transient: false,
				detail: `the last Claude subscription in the failover chain was also rejected (${decision.reason})`,
			})
			return null
		}
		lastReason = decision.reason
	}

	return null
}

/**
 * Drop a slot's recorded failure once it has proved healthy again. A no-op
 * (and no write) when the slot has no record, so this costs nothing on the
 * overwhelmingly common healthy path. Failures are swallowed: a session start
 * must not be blocked by bookkeeping.
 */
async function clearSlotFailureRecord(
	db: Database,
	workspaceId: string,
	slot: OAuthSlotKind,
): Promise<void> {
	try {
		await db.transaction(async (tx) => {
			const [latest] = await tx
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.for('update')
				.limit(1)
			if (!latest) return
			const latestSettings = (latest.settings as Record<string, unknown>) ?? {}
			const existing = readFailoverState(latestSettings.claude_oauth)
			const recorded = slotFailure(existing, slot)
			if (recorded.at === undefined && recorded.reason === undefined) return
			const nextOAuth = writeFailoverState(
				latestSettings.claude_oauth,
				withSlotFailure(existing, slot, undefined),
			)
			await tx
				.update(workspaces)
				.set({
					settings: { ...latestSettings, claude_oauth: nextOAuth },
					updatedAt: new Date(),
				})
				.where(eq(workspaces.id, workspaceId))
		})
	} catch (err) {
		logger.warn('Failed to clear a recovered Claude OAuth slot failure record', {
			workspaceId,
			slot,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Decrypt a slot, refresh if needed, and persist any refresh. `refreshFailure`
 * is set (and `tokens` left at the pre-refresh, possibly stale value) when the
 * refresh call itself throws — callers decide whether the stale token is still
 * safe to hand back based on its real `expiresAt`.
 */
async function loadAndRefreshSlot(
	db: Database,
	workspaceId: string,
	slot: OAuthSlotKind,
	encrypted: EncryptedOAuthData,
	bufferMs: number | undefined,
): Promise<{ tokens: ClaudeOAuthTokens; refreshFailure: ClassifierInput | null }> {
	const stored = decryptOAuthData(encrypted)
	try {
		const result = await refreshClaudeTokenIfNeeded(stored, bufferMs ?? 10 * 60 * 1000)
		if (result.refreshed) {
			await persistRefreshedSlot(db, workspaceId, slot, encryptOAuthTokens(result.tokens))
		}
		return { tokens: result.tokens, refreshFailure: null }
	} catch (err) {
		logger.warn('Failed to refresh Claude OAuth slot', {
			workspaceId,
			slot,
			error: err instanceof Error ? err.message : String(err),
		})
		// Carried back rather than discarded so the caller can tell a revoked
		// refresh token (permanent) from a token endpoint we simply could not
		// reach (transient, and worth a retry).
		return { tokens: stored, refreshFailure: classifierInputFromError(err) }
	}
}

/**
 * T7's lazy switch-back, run when the active slot is not the head of the
 * chain: refresh + probe the head OUTSIDE any lock, and flip `active_slot`
 * back to it if it answers healthily. Returns the head's credentials on a
 * successful recovery, `null` when it's still unhealthy (or another caller
 * won the race).
 */
async function attemptChainHeadRecovery(params: {
	db: Database
	workspaceId: string
	actorId: string
	probe: SubscriptionProbe
	bufferMs: number | undefined
	now: number
}): Promise<ClaudeCredentials | null> {
	const { db, workspaceId, actorId, probe, bufferMs, now } = params
	let recoveredTokens: ClaudeOAuthTokens | null = null
	let recoveredNeedsPersist = false

	const recovery = await attemptPrimaryRecovery({
		db,
		workspaceId,
		actorId,
		now,
		healthCheck: async (head) => {
			const decrypted = decryptOAuthData(head)
			try {
				const { tokens, refreshed } = await refreshClaudeTokenIfNeeded(
					decrypted,
					bufferMs ?? 10 * 60 * 1000,
				)
				const probeResult = await runProbe(probe, tokens)
				if (probeResult) {
					const decision = classifyClaudeFailure(probeResult)
					return { healthy: false, reason: decision.reason }
				}
				recoveredTokens = tokens
				recoveredNeedsPersist = refreshed
				return { healthy: true }
			} catch (err) {
				const decision = classifyClaudeFailure(classifierInputFromError(err))
				return { healthy: false, reason: decision.reason }
			}
		},
	})

	if (!recovery.recovered || !recoveredTokens) return null

	if (recoveredNeedsPersist) {
		// Persist AFTER attemptPrimaryRecovery's transaction has released its
		// row lock — persisting from inside `healthCheck` (which runs under
		// that lock) would open a second transaction competing for the same
		// lock and deadlock against itself.
		await persistRefreshedSlot(db, workspaceId, recovery.slot, encryptOAuthTokens(recoveredTokens))
	}
	return { slot: recovery.slot, tokens: recoveredTokens }
}

/**
 * Flip `active_slot` forward to the next slot in the chain and insert the
 * failover event. Wrapped in a `SELECT … FOR UPDATE` on the workspaces row so
 * concurrent session-starts in the same failure window serialize; the second
 * tx sees the bucket + reason already recorded and skips the event insert
 * (AC-T2). The slot flip itself is idempotent — both sessions still land on
 * the same next slot.
 */
async function recordFailoverTransition(params: {
	db: Database
	workspaceId: string
	actorId: string
	fromSlot: OAuthSlotKind
	toSlot: OAuthSlotKind
	bucket: number
	reason: string
}): Promise<void> {
	const { db, workspaceId, actorId, fromSlot, toSlot, bucket, reason } = params
	const inserted = await db.transaction(async (tx) => {
		const [latest] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!latest) return false
		const latestSettings = (latest.settings as Record<string, unknown>) ?? {}
		const existing = readFailoverState(latestSettings.claude_oauth)
		const recorded = slotFailure(existing, fromSlot)
		const alreadyRecorded =
			existing.active_slot === toSlot && recorded.at === bucket && recorded.reason === reason
		if (alreadyRecorded) return false

		const nextState = withSlotFailure({ ...existing, active_slot: toSlot }, fromSlot, {
			at: bucket,
			reason,
		})
		const nextOAuth = writeFailoverState(latestSettings.claude_oauth, nextState)
		await tx
			.update(workspaces)
			.set({
				settings: { ...latestSettings, claude_oauth: nextOAuth },
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))

		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: FAILOVER_TRIGGERED_ACTION,
			entityType: 'workspace',
			entityId: workspaceId,
			data: { reason, failure_window: bucket, from_slot: fromSlot, to_slot: toSlot },
		})
		return true
	})
	if (!inserted) return
	logger.info('Claude subscription failed over to the next slot', {
		workspaceId,
		fromSlot,
		toSlot,
		reason,
		failure_window: bucket,
	})
	// PostHog forwarding — runs after the tx commits so we don't hold the
	// workspace row lock across the network fetch. The AC-T2 dedup skip
	// path returns `inserted=false` above, so PostHog also fires exactly
	// once per failure window.
	await trackClaudeSubscriptionFailoverTriggered({
		workspaceId,
		actorId,
		reason,
		failureWindow: bucket,
		trigger: 'session_start',
	})
}

/**
 * Record that the last slot in the chain was rejected too — nothing is left
 * to fall over to. Keeps `active_slot` where it is (there is nowhere forward
 * to point it) and stamps the slot's failure so the settings UI can say which
 * credential died and why.
 */
async function recordChainExhausted(params: {
	db: Database
	workspaceId: string
	actorId: string
	slot: OAuthSlotKind
	reason: string
	now: number
}): Promise<void> {
	const { db, workspaceId, actorId, slot, reason, now } = params
	await recordRuntimeClaudeOAuthBackupExhausted({
		db,
		workspaceId,
		actorId,
		reason,
		now,
		slot,
	})
}

/**
 * Outcome of a mid-session runtime failover attempt. `exhausted` and
 * `superseded` are deliberately distinct: the first means the workspace has
 * genuinely run out of subscriptions (worth telling the user about), the
 * second means another session already moved the pointer on (say nothing).
 */
export type RuntimeFailoverOutcome =
	| { moved: true; slot: OAuthSlotKind }
	| { moved: false; reason: 'exhausted' | 'superseded' | 'no_workspace' }

/**
 * Mid-session runtime failover: a live session on `fromSlot` hit a usage limit
 * or an auth rejection. Flips `active_slot` onto the next slot in the chain
 * and records the event.
 */
export async function recordRuntimeClaudeOAuthFailover(params: {
	db: Database
	workspaceId: string
	actorId: string
	reason: string
	/** The slot the failing session was running on. Defaults to the head. */
	fromSlot?: OAuthSlotKind
	now?: number
	sourceSessionId?: string
}): Promise<RuntimeFailoverOutcome> {
	const { db, workspaceId, actorId, reason, sourceSessionId } = params
	const now = params.now ?? Date.now()
	// Written from inside the transaction callback; TS can't narrow a union
	// assigned in a closure, so the two halves are tracked separately and
	// composed into the outcome afterwards.
	let movedTo: OAuthSlotKind | null = null
	let blocked: 'exhausted' | 'superseded' | 'no_workspace' = 'no_workspace'

	await db.transaction(async (tx) => {
		const [latest] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!latest) return

		const latestSettings = (latest.settings as Record<string, unknown>) ?? {}
		const existing = readFailoverState(latestSettings.claude_oauth)
		const fromSlot = params.fromSlot ?? readChain(latestSettings.claude_oauth)[0]?.id
		if (!fromSlot) return
		// Only the session running on the CURRENTLY active slot may advance the
		// pointer — otherwise a straggler finishing on an abandoned slot would
		// drag the workspace backwards or skip a slot nobody has tried yet.
		if (existing.active_slot !== fromSlot) {
			blocked = 'superseded'
			return
		}
		const toSlot = nextSlotAfter(latestSettings.claude_oauth, fromSlot)
		if (!toSlot) {
			blocked = 'exhausted'
			return
		}

		const nextState = withSlotFailure({ ...existing, active_slot: toSlot }, fromSlot, {
			at: now,
			reason,
		})
		const nextOAuth = writeFailoverState(latestSettings.claude_oauth, nextState)
		await tx
			.update(workspaces)
			.set({
				settings: { ...latestSettings, claude_oauth: nextOAuth },
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))

		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: FAILOVER_TRIGGERED_ACTION,
			entityType: 'workspace',
			entityId: workspaceId,
			data: {
				reason,
				failure_window: now,
				from_slot: fromSlot,
				to_slot: toSlot,
				trigger: 'runtime_session_failure',
				...(sourceSessionId ? { source_session_id: sourceSessionId } : {}),
			},
		})
		movedTo = toSlot
	})

	if (movedTo) {
		logger.info('Claude subscription failed over after runtime session failure', {
			workspaceId,
			toSlot: movedTo,
			reason,
			sourceSessionId,
		})
		await trackClaudeSubscriptionFailoverTriggered({
			workspaceId,
			actorId,
			reason,
			failureWindow: now,
			trigger: 'runtime_session_failure',
			sourceSessionId,
		})
	}

	return movedTo ? { moved: true, slot: movedTo } : { moved: false, reason: blocked }
}

/**
 * Record that the workspace has run out of Claude subscriptions to try: the
 * last slot in the chain was rejected too. `slot` names the credential that
 * was rejected (the active one by default).
 */
export async function recordRuntimeClaudeOAuthBackupExhausted(params: {
	db: Database
	workspaceId: string
	actorId: string
	reason: string
	slot?: OAuthSlotKind
	now?: number
	sourceSessionId?: string
}): Promise<void> {
	const { db, workspaceId, actorId, reason, sourceSessionId } = params
	const now = params.now ?? Date.now()

	await db.transaction(async (tx) => {
		const [latest] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!latest) return

		const latestSettings = (latest.settings as Record<string, unknown>) ?? {}
		const existing = readFailoverState(latestSettings.claude_oauth)
		const slot = params.slot ?? existing.active_slot
		const recorded = slotFailure(existing, slot)
		const alreadyRecorded = recorded.at === now && recorded.reason === reason

		if (!alreadyRecorded) {
			// `active_slot` stays put: there is no slot after this one to point
			// it at, and moving it would orphan the chain.
			const nextState = withSlotFailure({ ...existing, active_slot: slot }, slot, {
				at: now,
				reason,
			})
			const nextOAuth = writeFailoverState(latestSettings.claude_oauth, nextState)
			await tx
				.update(workspaces)
				.set({
					settings: { ...latestSettings, claude_oauth: nextOAuth },
					updatedAt: new Date(),
				})
				.where(eq(workspaces.id, workspaceId))
		}

		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: BACKUP_EXHAUSTED_ACTION,
			entityType: 'workspace',
			entityId: workspaceId,
			data: {
				reason,
				failure_window: now,
				slot,
				trigger: 'runtime_session_failure',
				...(sourceSessionId ? { source_session_id: sourceSessionId } : {}),
			},
		})
	})

	logger.info('Claude subscription chain exhausted after runtime session failure', {
		workspaceId,
		reason,
		sourceSessionId,
	})
	await trackClaudeSubscriptionBackupExhausted({
		workspaceId,
		actorId,
		reason,
		failureWindow: now,
		sourceSessionId,
	})
}

/**
 * Maps a classified refresh/probe verdict onto the unusable-credential report.
 * A `failover` verdict is auth-class and will repeat; anything else reaching a
 * null return is a transient failure over an already-expired token — unusable
 * right now, but not proof the credential is dead.
 */
function unusableFromRefresh(decision: { action: string; reason: string }): UnusableCredentialInfo {
	return decision.action === 'failover'
		? {
				transient: false,
				detail: `the connected Claude subscription was rejected (${decision.reason})`,
			}
		: {
				transient: true,
				detail: `the Claude token endpoint could not be reached to refresh an expired token (${decision.reason})`,
			}
}

/**
 * Is a thrown credential error worth retrying? Routes the throw through the
 * same classifier the null paths use, so a timeout from
 * CLAUDE_CREDENTIAL_TIMEOUT_MS or a 5xx reads as transient while a 401 does
 * not. Keeps the throw and null paths agreeing on what "permanent" means.
 */
export function isTransientCredentialError(err: unknown): boolean {
	return classifyClaudeFailure(classifierInputFromError(err)).action !== 'failover'
}

async function runProbe(
	probe: SubscriptionProbe,
	tokens: ClaudeOAuthTokens,
): Promise<ClassifierInput | null> {
	try {
		return await probe(tokens)
	} catch {
		// A thrown probe (e.g. DNS failure, unhandled promise) is a transport
		// error — feed it to the classifier as such so we don't unwarrantedly
		// failover on our own client crash.
		return { kind: 'transport', error: 'network' }
	}
}

/**
 * Extract a classifier input from a refresh error. `refreshClaudeToken`
 * throws `Error('Token refresh failed (STATUS): body')` on non-2xx; parse
 * the status so 401 → auth_failed and 5xx → retry-primary land on the
 * expected fixtures from AC-T3.
 *
 * The OAuth token endpoint (unlike the Messages API) returns 4xx — most
 * commonly 400 `invalid_grant` — whenever the stored refresh token itself is
 * no longer usable (revoked, expired past the refresh window, rotated by a
 * concurrent refresh). That's the same "this credential is dead, not
 * temporarily unavailable" signal a live 401 carries, so every refresh-time
 * 4xx is normalised onto 401 here and lands on the same `auth_failed` →
 * failover bucket — otherwise it would fall through the classifier's generic
 * default and retry a refresh that can never succeed. 429/5xx pass through
 * unchanged so a rate-limited or momentarily-down token endpoint still
 * retries the primary. Anything unparseable maps to a network transport
 * failure so we don't classify a client-side bug as failover.
 */
function classifierInputFromError(err: unknown): ClassifierInput {
	const message = err instanceof Error ? err.message : String(err)
	const match = message.match(/\((\d{3})\)/)
	if (match) {
		const status = Number(match[1])
		const isTokenEndpointAuthFailure = status >= 400 && status < 500 && status !== 429
		return {
			kind: 'http',
			status: isTokenEndpointAuthFailure ? 401 : status,
			headers: headersFrom({}),
		}
	}
	return { kind: 'transport', error: 'network' }
}
