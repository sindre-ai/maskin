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
	type ClaudeOAuthTokens,
	type EncryptedOAuthData,
	decryptOAuthData,
	encryptOAuthTokens,
	persistRefreshedSlot,
	refreshClaudeTokenIfNeeded,
} from './claude-oauth'
import { attemptPrimaryRecovery, shouldAttemptPrimaryRecovery } from './claude-oauth-recovery'
import {
	type OAuthFailoverState,
	type OAuthSlotKind,
	readFailoverState,
	readSlots,
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

/** Feature-flag env var — AC-T5. Flag off → legacy primary-only path. */
export const CLAUDE_FAILOVER_FLAG_ENV = 'MASKIN_CLAUDE_FAILOVER_ENABLED'

/** Emitted on the workspace when the primary fails over to the backup. */
export const FAILOVER_TRIGGERED_ACTION = 'claude_subscription_failover_triggered'

/** Emitted when the backup subscription also rejects a runtime session. */
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
}

export function isClaudeFailoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env[CLAUDE_FAILOVER_FLAG_ENV] ?? '').trim().toLowerCase() === 'true'
}

/**
 * Session-start entry point for Claude subscription credentials.
 *
 * Flag off (AC-T5): always primary-only, regardless of whatever
 * `active_slot` a prior (flag-on) failover may have persisted — reads the
 * primary slot directly rather than through the slot resolver, so disabling
 * the flag as an incident kill-switch actually forces routing back to
 * primary instead of silently continuing to serve backup. No probe, no
 * event, no state write. Returns `null` when nothing is configured or the
 * primary can't be refreshed.
 *
 * Flag on: reads slots + failover state. If `active_slot === 'primary'`
 * (or the row still has the legacy shape), probes the primary token and
 * classifies the response via T4. On a `failover` verdict AND a backup
 * being connected, flips `active_slot` to backup and emits
 * `claude_subscription_failover_triggered` under one `db.transaction` +
 * `SELECT … FOR UPDATE` on the workspaces row; the failure-window bucket
 * (60s) + classified reason form the de-dup key so a second concurrent
 * session in the same window sees the same bucket+reason under the lock
 * and skips the insert (AC-T2). AC-U4: with only a primary connected the
 * `failover` verdict returns the primary tokens unchanged — the caller
 * (session container) falls back to today's hard-failure behaviour.
 *
 * If `active_slot === 'backup'`, T7's lazy recovery (`attemptPrimaryRecovery`)
 * is attempted once the cooldown has elapsed (AC-U6). Otherwise we refresh
 * and probe the backup before returning it, so a dead backup can fall through
 * to the next LLM route instead of launching a doomed container.
 */
export async function resolveClaudeCredentialsWithFailover(
	params: FailoverParams,
): Promise<ClaudeCredentials | null> {
	const { db, workspaceId, actorId, bufferMs } = params
	const probe = params.probe ?? probeClaudeSubscription
	const env = params.env ?? process.env
	const now = params.now ?? Date.now

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) return null

	const wsSettings = (ws.settings as Record<string, unknown>) ?? {}
	const slots = readSlots(wsSettings.claude_oauth)

	if (!isClaudeFailoverEnabled(env)) {
		if (!slots.primary) return null
		const { tokens, refreshFailure } = await loadAndRefreshPrimary(
			db,
			workspaceId,
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
			if (decision.action === 'failover' || tokens.expiresAt <= now()) return null
		}
		return { slot: 'primary', tokens }
	}

	const failover = readFailoverState(wsSettings.claude_oauth)

	// Already flipped to backup on an earlier session.
	if (failover.active_slot === 'backup') {
		if (!slots.backup) return null

		if (shouldAttemptPrimaryRecovery({ slots, failover, now: now() })) {
			let recoveredTokens: ClaudeOAuthTokens | null = null
			let recoveredNeedsPersist = false
			const recovery = await attemptPrimaryRecovery({
				db,
				workspaceId,
				actorId,
				now: now(),
				healthCheck: async (primary) => {
					const decrypted = decryptOAuthData(primary)
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

			if (recovery.recovered && recoveredTokens) {
				if (recoveredNeedsPersist) {
					// Persist AFTER attemptPrimaryRecovery's transaction has released
					// its row lock — persisting from inside `healthCheck` (which runs
					// under that lock) would open a second transaction competing for
					// the same lock and deadlock against itself.
					await persistRefreshedSlot(
						db,
						workspaceId,
						'primary',
						encryptOAuthTokens(recoveredTokens),
					)
				}
				return { slot: 'primary', tokens: recoveredTokens }
			}
		}

		return refreshAndProbeBackup({
			db,
			workspaceId,
			actorId,
			backup: slots.backup,
			probe,
			bufferMs,
		})
	}

	if (!slots.primary) return null

	const { tokens: workingTokens, refreshFailure } = await loadAndRefreshPrimary(
		db,
		workspaceId,
		slots.primary,
		bufferMs,
	)

	const probeInput: ClassifierInput | null =
		refreshFailure ?? (await runProbe(probe, workingTokens))

	if (!probeInput) return { slot: 'primary', tokens: workingTokens }

	const decision = classifyClaudeFailure(probeInput)
	if (decision.action === 'retry_primary') {
		if (refreshFailure && workingTokens.expiresAt <= now()) {
			// The refresh itself failed transiently (network/5xx) AND the
			// fallback token is actually expired — not just inside the
			// proactive refresh buffer. Handing it back as "success" would
			// launch a session with dead credentials and never reach the
			// workspace API key / system fallback routes. Signal unusable so
			// the caller (llm-routing) falls through instead.
			return null
		}
		return { slot: 'primary', tokens: workingTokens }
	}

	// decision.action === 'failover' — AC-U2 / AC-T3.
	// AC-U4: only a primary is connected → no silent fallback to nothing.
	if (!slots.backup) return { slot: 'primary', tokens: workingTokens }

	const bucket = Math.floor(now() / FAILURE_WINDOW_BUCKET_MS) * FAILURE_WINDOW_BUCKET_MS
	await recordFailoverTransition({
		db,
		workspaceId,
		actorId,
		bucket,
		reason: decision.reason,
	})

	return refreshAndProbeBackup({ db, workspaceId, actorId, backup: slots.backup, probe, bufferMs })
}

/**
 * Decrypt the primary slot, refresh if needed, and persist any refresh.
 * `refreshFailure` is set (and `tokens` left at the pre-refresh, possibly
 * stale value) when the refresh call itself throws — callers decide whether
 * the stale token is still safe to hand back based on its real `expiresAt`.
 */
async function loadAndRefreshPrimary(
	db: Database,
	workspaceId: string,
	primary: EncryptedOAuthData,
	bufferMs: number | undefined,
): Promise<{ tokens: ClaudeOAuthTokens; refreshFailure: ClassifierInput | null }> {
	const primaryTokens = decryptOAuthData(primary)
	try {
		const result = await refreshClaudeTokenIfNeeded(primaryTokens, bufferMs ?? 10 * 60 * 1000)
		if (result.refreshed) {
			await persistRefreshedSlot(db, workspaceId, 'primary', encryptOAuthTokens(result.tokens))
		}
		return { tokens: result.tokens, refreshFailure: null }
	} catch (err) {
		return { tokens: primaryTokens, refreshFailure: classifierInputFromError(err) }
	}
}

/**
 * Flip `active_slot` to backup and insert the failover event. Wrapped in a
 * `SELECT … FOR UPDATE` on the workspaces row so concurrent session-starts
 * in the same failure window serialize; the second tx sees the bucket +
 * reason already recorded and skips the event insert (AC-T2). The slot
 * flip itself is idempotent — both sessions still return backup.
 */
async function recordFailoverTransition(params: {
	db: Database
	workspaceId: string
	actorId: string
	bucket: number
	reason: string
}): Promise<void> {
	const { db, workspaceId, actorId, bucket, reason } = params
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
		const alreadyRecorded =
			existing.active_slot === 'backup' &&
			existing.last_primary_failure_at === bucket &&
			existing.last_classified_reason === reason
		if (alreadyRecorded) return false

		const nextState: OAuthFailoverState = {
			active_slot: 'backup',
			last_primary_failure_at: bucket,
			last_classified_reason: reason,
		}
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
			data: { reason, failure_window: bucket },
		})
		return true
	})
	if (!inserted) return
	logger.info('Claude subscription failed over to backup', {
		workspaceId,
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

export async function recordRuntimeClaudeOAuthFailover(params: {
	db: Database
	workspaceId: string
	actorId: string
	reason: string
	now?: number
	sourceSessionId?: string
}): Promise<boolean> {
	const { db, workspaceId, actorId, reason, sourceSessionId } = params
	const now = params.now ?? Date.now()
	let didFailover = false

	await db.transaction(async (tx) => {
		const [latest] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!latest) return

		const latestSettings = (latest.settings as Record<string, unknown>) ?? {}
		const slots = readSlots(latestSettings.claude_oauth)
		const existing = readFailoverState(latestSettings.claude_oauth)
		if (existing.active_slot !== 'primary' || !slots.backup) return

		const nextState: OAuthFailoverState = {
			active_slot: 'backup',
			last_primary_failure_at: now,
			last_classified_reason: reason,
		}
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
				trigger: 'runtime_session_failure',
				...(sourceSessionId ? { source_session_id: sourceSessionId } : {}),
			},
		})
		didFailover = true
	})

	if (didFailover) {
		logger.info('Claude subscription failed over to backup after runtime session failure', {
			workspaceId,
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

	return didFailover
}

export async function recordRuntimeClaudeOAuthBackupExhausted(params: {
	db: Database
	workspaceId: string
	actorId: string
	reason: string
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
		const alreadyRecorded =
			existing.active_slot === 'backup' &&
			existing.last_backup_failure_at === now &&
			existing.last_backup_classified_reason === reason

		if (!alreadyRecorded) {
			const nextState: OAuthFailoverState = {
				...existing,
				active_slot: 'backup',
				last_backup_failure_at: now,
				last_backup_classified_reason: reason,
			}
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
				trigger: 'runtime_session_failure',
				...(sourceSessionId ? { source_session_id: sourceSessionId } : {}),
			},
		})
	})

	logger.info('Claude backup subscription exhausted after runtime session failure', {
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
 * Refresh the requested slot's tokens if they're about to expire, persist
 * the refreshed blob via T5's slot-safe helper, and return the fresh
 * plaintext tokens. Returns `null` when a refresh unexpectedly throws — the
 * caller treats that as "no credentials for this slot".
 */
async function refreshSlot(
	db: Database,
	workspaceId: string,
	slot: OAuthSlotKind,
	encrypted: EncryptedOAuthData,
	bufferMs: number | undefined,
): Promise<ClaudeOAuthTokens | null> {
	const decrypted = decryptOAuthData(encrypted)
	try {
		const result = await refreshClaudeTokenIfNeeded(decrypted, bufferMs ?? 10 * 60 * 1000)
		if (result.refreshed) {
			await persistRefreshedSlot(db, workspaceId, slot, encryptOAuthTokens(result.tokens))
		}
		return result.tokens
	} catch (err) {
		logger.warn('Failed to refresh Claude OAuth slot', {
			workspaceId,
			slot,
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

/**
 * Refresh the backup slot, probe it, and classify the response. Returns the
 * backup credentials when healthy, or `null` when the refresh fails or the
 * backup itself reports a failover-worthy failure (recording
 * `claude_subscription_backup_exhausted` in that last case).
 */
async function refreshAndProbeBackup(params: {
	db: Database
	workspaceId: string
	actorId: string
	backup: EncryptedOAuthData
	probe: SubscriptionProbe
	bufferMs: number | undefined
}): Promise<ClaudeCredentials | null> {
	const { db, workspaceId, actorId, backup, probe, bufferMs } = params
	const backupTokens = await refreshSlot(db, workspaceId, 'backup', backup, bufferMs)
	if (!backupTokens) return null
	const backupProbeInput = await runProbe(probe, backupTokens)
	if (backupProbeInput) {
		const backupDecision = classifyClaudeFailure(backupProbeInput)
		if (backupDecision.action === 'failover') {
			await recordRuntimeClaudeOAuthBackupExhausted({
				db,
				workspaceId,
				actorId,
				reason: backupDecision.reason,
			})
			return null
		}
	}
	return { slot: 'backup', tokens: backupTokens }
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
