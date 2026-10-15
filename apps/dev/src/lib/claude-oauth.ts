import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_TOKEN_URL } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { type OAuthSlotKind, readSlots, resolveActiveSlot, writeSlot } from './claude-oauth-slots'
import { decrypt, encrypt } from './crypto'
import { logger } from './logger'
import { Sentry } from './sentry'

/**
 * Hard ceiling on every network call made while resolving Claude credentials
 * (this token refresh, and `probeClaudeSubscription` in claude-failover.ts).
 *
 * These calls sit on the session-launch path, before the session row leaves
 * `starting`. A hung socket here is not a slow start — it is a session that
 * never launches and never fails, invisible until the 10-minute zombie reaper
 * force-fails it with a generic message. Bounding it well under that window
 * turns the hang into a classified, reported failure (a refresh timeout is
 * normalised to a transport error, so it retries the primary rather than
 * failing over on our own network blip).
 */
export const CLAUDE_CREDENTIAL_TIMEOUT_MS = 15_000

/**
 * Runtime kill-switch for keeping the Claude refresh token out of agent
 * containers. Default is OFF: only the literal string `true` enables it, until
 * the launch check (one real session start in the real image with no refresh
 * token) has passed, so a missing env keeps today's behaviour. On, the platform refreshes at
 * session launch with a session-sized buffer and the container is handed an
 * access token only. Off restores today's behaviour exactly: the container gets
 * the refresh token and the default 10 minute buffer.
 */
export const CLAUDE_PLATFORM_REFRESH_FLAG_ENV = 'MASKIN_CLAUDE_PLATFORM_REFRESH_ENABLED'

/** Setting for how much access-token life a session launch must start with. */
export const CLAUDE_LAUNCH_BUFFER_ENV = 'CLAUDE_LAUNCH_BUFFER_MS'

/**
 * Default launch buffer: 3 h. Covers the longest observed run (2.77 h) and the
 * 2 h session timeout cap with headroom.
 */
export const DEFAULT_CLAUDE_LAUNCH_BUFFER_MS = 3 * 60 * 60 * 1000

export function isClaudePlatformRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env[CLAUDE_PLATFORM_REFRESH_FLAG_ENV] ?? '').trim().toLowerCase() === 'true'
}

/** The launch buffer setting; anything that is not a positive number falls back to the default. */
export function readClaudeLaunchBufferMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env[CLAUDE_LAUNCH_BUFFER_ENV])
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLAUDE_LAUNCH_BUFFER_MS
}

/**
 * How far ahead of expiry a slot must be refreshed. A number is a fixed buffer.
 * `{ launchMs }` is the session-launch policy: the setting, capped at half the
 * slot's known access-token lifetime, and a slot with no known lifetime is
 * refreshed once so the lifetime becomes known.
 */
export type RefreshBuffer = number | { launchMs: number }

/**
 * Access-token lifetime per workspace+slot, in memory only (no extra storage).
 * Set by every refresh through refreshSlotSingleFlight, so only the first
 * launch per slot after a restart pays for a forced refresh.
 */
const slotLifetimesMs = new Map<string, number>()

/** Test seam: forget every learned lifetime. */
export function resetClaudeSlotLifetimes(): void {
	slotLifetimesMs.clear()
}

function needsRefresh(key: string, expiresAt: number, buffer: RefreshBuffer): boolean {
	if (typeof buffer === 'number') return expiresAt <= Date.now() + buffer
	const lifetime = slotLifetimesMs.get(key)
	if (lifetime === undefined) return true
	return expiresAt <= Date.now() + Math.min(buffer.launchMs, lifetime / 2)
}

export interface ClaudeOAuthTokens {
	accessToken: string
	refreshToken: string
	expiresAt: number
	subscriptionType?: string
	scopes?: string[]
	nickname?: string
}

interface TokenResponse {
	access_token: string
	refresh_token?: string
	expires_in: number
	scope?: string
	subscription_type?: string
}

/**
 * Thrown by `refreshClaudeToken` for every failure of the token endpoint call
 * (non-2xx, timeout, network error). The message is exactly what the bare
 * `Error` carried before: `classifierInputFromError` in claude-failover.ts
 * parses the status out of it. The structured fields exist only so
 * `reportClaudeRefreshFailure` can record a failure without parsing text.
 *
 * `errorType` is the token endpoint's OAuth error code (invalid_grant, ...) or
 * `timeout` / `network` / `unknown`. It is always a short [a-z0-9_.-] string,
 * never response text, so it is safe to store.
 */
export class ClaudeTokenRefreshError extends Error {
	readonly status: number | null
	readonly errorType: string
	constructor(message: string, status: number | null, errorType: string, cause?: unknown) {
		super(message, { cause })
		this.status = status
		this.errorType = errorType
	}
}

const ERROR_TYPE_PATTERN = /^[a-z0-9_.-]{1,64}$/i

/** OAuth error code from a token endpoint body: {error: "x"} or {error: {type: "x"}}. */
function parseErrorType(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: unknown } | null
		const error = parsed?.error
		const candidate = typeof error === 'string' ? error : (error as { type?: unknown } | null)?.type
		if (typeof candidate === 'string' && ERROR_TYPE_PATTERN.test(candidate)) return candidate
	} catch {
		// Not JSON: nothing in it is safe to keep.
	}
	return 'unknown'
}

/** Which code path asked for the refresh. */
export type ClaudeRefreshCaller = 'session_start' | 'failover_recovery' | 'keys_status'

/**
 * Leave a durable record of a failed token refresh as a Sentry event (logs are
 * off in production, and the api's own stdout only survives about a minute).
 *
 * Only failures of the token endpoint call itself are recorded; anything else
 * a caller's try block can throw (a DB write, say) is not a refresh failure
 * and is ignored. Fields are an allowlist: ids, status, the OAuth error code,
 * the caller and a timestamp. The error message is deliberately left out
 * because it carries the endpoint's response body.
 *
 * Never throws and never changes what the caller does next.
 */
export function reportClaudeRefreshFailure(params: {
	workspaceId: string
	slot: string
	caller: ClaudeRefreshCaller
	error: unknown
}): void {
	const { workspaceId, slot, caller, error } = params
	if (!(error instanceof ClaudeTokenRefreshError)) return
	try {
		const status = error.status === null ? 'none' : String(error.status)
		Sentry.captureMessage('Claude OAuth token refresh failed', {
			level: 'warning',
			tags: { caller, slot, http_status: status, error_type: error.errorType },
			extra: {
				workspaceId,
				slot,
				caller,
				httpStatus: error.status,
				errorType: error.errorType,
				failedAt: new Date().toISOString(),
			},
			fingerprint: ['claude-oauth-refresh-failed', caller, status, error.errorType],
		})
	} catch (sentryErr) {
		console.error('[sentry] captureMessage failed', sentryErr)
	}
}

/**
 * Refresh an expired access token using the refresh token.
 * Returns updated tokens (new access token, possibly new refresh token).
 */
export async function refreshClaudeToken(tokens: ClaudeOAuthTokens): Promise<ClaudeOAuthTokens> {
	const body = {
		grant_type: 'refresh_token',
		client_id: CLAUDE_OAUTH_CLIENT_ID,
		refresh_token: tokens.refreshToken,
	}

	let res: Response
	try {
		res = await fetch(CLAUDE_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(CLAUDE_CREDENTIAL_TIMEOUT_MS),
		})
	} catch (err) {
		const timedOut =
			err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
		throw new ClaudeTokenRefreshError(
			err instanceof Error ? err.message : String(err),
			null,
			timedOut ? 'timeout' : 'network',
			err,
		)
	}

	if (!res.ok) {
		const text = await res.text()
		throw new ClaudeTokenRefreshError(
			`Token refresh failed (${res.status}): ${text}`,
			res.status,
			parseErrorType(text),
		)
	}

	const data = (await res.json()) as TokenResponse
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? tokens.refreshToken,
		expiresAt: Date.now() + data.expires_in * 1000,
		subscriptionType: tokens.subscriptionType,
		scopes: data.scope?.split(' ') ?? tokens.scopes,
		// The nickname is user-authored metadata that happens to ride along in
		// the token record. Rebuilding the record without it here is what made
		// nicknames vanish on their own: the refreshed blob is persisted over
		// the slot wholesale, so anything dropped here is dropped from storage.
		// The same is true of every other non-token field on the record — add
		// new ones HERE, not only to the interface.
		nickname: tokens.nickname,
	}
}

/**
 * Refresh tokens if they expire within the given buffer (default 10 minutes).
 * Returns the original tokens if still valid, or refreshed tokens.
 */
export async function refreshClaudeTokenIfNeeded(
	tokens: ClaudeOAuthTokens,
	bufferMs = 10 * 60 * 1000,
): Promise<{ tokens: ClaudeOAuthTokens; refreshed: boolean }> {
	if (tokens.expiresAt > Date.now() + bufferMs) {
		return { tokens, refreshed: false }
	}

	logger.info('Claude OAuth token expiring soon, refreshing...')
	const refreshed = await refreshClaudeToken(tokens)
	return { tokens: refreshed, refreshed: true }
}

export interface EncryptedOAuthData {
	encryptedAccessToken: string
	encryptedRefreshToken: string
	expiresAt: number
	subscriptionType?: string
	scopes?: string[]
	nickname?: string
}

/**
 * Decrypt stored OAuth data into usable tokens.
 */
export function decryptOAuthData(data: EncryptedOAuthData): ClaudeOAuthTokens {
	return {
		accessToken: decrypt(data.encryptedAccessToken),
		refreshToken: decrypt(data.encryptedRefreshToken),
		expiresAt: data.expiresAt,
		subscriptionType: data.subscriptionType,
		scopes: data.scopes,
		nickname: data.nickname,
	}
}

/**
 * Encrypt plaintext tokens into the stored format.
 */
export function encryptOAuthTokens(tokens: ClaudeOAuthTokens): EncryptedOAuthData {
	return {
		encryptedAccessToken: encrypt(tokens.accessToken),
		encryptedRefreshToken: encrypt(tokens.refreshToken),
		expiresAt: tokens.expiresAt,
		subscriptionType: tokens.subscriptionType,
		scopes: tokens.scopes,
		nickname: tokens.nickname,
	}
}

/**
 * Carry a slot's nickname from what is already stored onto a blob that is
 * about to replace it. The nickname is not token material: a write that only
 * means to rotate credentials must not silently erase how the credential is
 * labelled.
 *
 * An incoming value always wins, so a rename still takes effect; only
 * `undefined` falls back to what was there.
 */
export function preserveSlotLabels(
	incoming: EncryptedOAuthData,
	stored: EncryptedOAuthData | undefined,
): EncryptedOAuthData {
	if (!stored) return incoming
	const next = { ...incoming }
	if (next.nickname === undefined && stored.nickname !== undefined) {
		next.nickname = stored.nickname
	}
	return next
}

/**
 * Persist a freshly-refreshed encrypted token blob into the given slot on a
 * workspace, without clobbering any other slot or failover state a concurrent
 * refresh may have written. Wraps the read-modify-write in a transaction with
 * `SELECT ... FOR UPDATE` so two parallel refreshes targeting different slots
 * on the same workspace row serialize at the DB level — each one sees the
 * other's fresh data on its locked re-read and merges its slot on top via
 * `writeSlot`. The lock spans only the brief read+update; the network refresh
 * happens beforehand.
 */
export async function persistRefreshedSlot(
	db: Database,
	workspaceId: string,
	slot: OAuthSlotKind,
	encrypted: EncryptedOAuthData,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [latest] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!latest) return
		const latestSettings = (latest.settings as Record<string, unknown>) ?? {}
		// Second line of defence for the nickname: this function only ever
		// persists refreshed TOKENS, so it must never be the thing that clears
		// a label. A rename racing a refresh would otherwise be lost, since
		// `encrypted` was built from a snapshot taken before the lock.
		const stored = readSlots(latestSettings.claude_oauth)[slot]
		const merged = preserveSlotLabels(encrypted, stored)
		const nextOAuth = writeSlot(latestSettings.claude_oauth, slot, merged)
		await tx
			.update(workspaces)
			.set({
				settings: { ...latestSettings, claude_oauth: nextOAuth },
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))
	})
}

const slotRefreshTails = new Map<string, Promise<unknown>>()

/**
 * In-process mutex per workspace+slot. Callers queue behind the previous one
 * for at most CLAUDE_CREDENTIAL_TIMEOUT_MS, so a hung refresh cannot stall
 * every session start behind it. The timeout error carries no HTTP status, so
 * the failover classifier reads it as a transient transport failure.
 */
async function withSlotRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = slotRefreshTails.get(key)
	const run = (async () => {
		if (previous) {
			let timer: ReturnType<typeof setTimeout> | undefined
			const timedOut = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Timed out waiting for a concurrent Claude token refresh')),
					CLAUDE_CREDENTIAL_TIMEOUT_MS,
				)
			})
			try {
				await Promise.race([previous, timedOut])
			} finally {
				clearTimeout(timer)
			}
		}
		return fn()
	})()
	const tail = run.then(
		() => undefined,
		() => undefined,
	)
	slotRefreshTails.set(key, tail)
	void tail.then(() => {
		if (slotRefreshTails.get(key) === tail) slotRefreshTails.delete(key)
	})
	return run
}

/**
 * Single-flight refresh of one slot: the only path that may spend a slot's
 * refresh token. Callers inside the expiry buffer queue per workspace+slot; the
 * lock spans re-read, refresh and persist, and each waiter re-reads the slot so
 * it skips the refresh when the caller ahead of it already wrote fresh tokens.
 * The lock is never held across the subscription probe.
 *
 * If the token endpoint rejects the refresh token but the stored one has since
 * changed (another process rotated it), the stored tokens are returned instead
 * of the error, so the slot is not failed over for a race it did not lose.
 */
export async function refreshSlotSingleFlight(
	db: Database,
	workspaceId: string,
	slot: OAuthSlotKind,
	stored: EncryptedOAuthData,
	bufferMs: RefreshBuffer = 10 * 60 * 1000,
): Promise<{ tokens: ClaudeOAuthTokens; refreshed: boolean }> {
	const key = `${workspaceId}:${slot}`
	if (!needsRefresh(key, stored.expiresAt, bufferMs)) {
		return { tokens: decryptOAuthData(stored), refreshed: false }
	}
	return withSlotRefreshLock(key, async () => {
		const readStored = async () => {
			const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
			const settings = (ws?.settings as Record<string, unknown>) ?? {}
			return readSlots(settings.claude_oauth)[slot]
		}
		const tokens = decryptOAuthData((await readStored()) ?? stored)
		try {
			if (!needsRefresh(key, tokens.expiresAt, bufferMs)) return { tokens, refreshed: false }
			logger.info('Claude OAuth token expiring soon, refreshing...')
			const refreshedTokens = await refreshClaudeToken(tokens)
			// Lower bound on the real lifetime (expires_in minus the call's own
			// latency), so the half-life guard errs on the safe side.
			const lifetimeMs = refreshedTokens.expiresAt - Date.now()
			if (Number.isFinite(lifetimeMs) && lifetimeMs > 0) slotLifetimesMs.set(key, lifetimeMs)
			await persistRefreshedSlot(db, workspaceId, slot, encryptOAuthTokens(refreshedTokens))
			return { tokens: refreshedTokens, refreshed: true }
		} catch (err) {
			const latest = await readStored().catch(() => undefined)
			if (latest && decrypt(latest.encryptedRefreshToken) !== tokens.refreshToken) {
				return { tokens: decryptOAuthData(latest), refreshed: false }
			}
			throw err
		}
	})
}

/**
 * Load, refresh if needed, and persist OAuth tokens for a workspace.
 * Returns the fresh access token or null if no OAuth is configured.
 */
export async function getValidOAuthToken(
	db: Database,
	workspaceId: string,
	bufferMs = 10 * 60 * 1000,
	caller: ClaudeRefreshCaller = 'session_start',
): Promise<{ accessToken: string; tokens: ClaudeOAuthTokens } | null> {
	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const wsSettings = (ws?.settings as Record<string, unknown>) ?? {}
	const active = resolveActiveSlot(wsSettings.claude_oauth)

	if (!active) return null

	let result: Awaited<ReturnType<typeof refreshSlotSingleFlight>>
	try {
		result = await refreshSlotSingleFlight(db, workspaceId, active.slot, active.data, bufferMs)
	} catch (error) {
		reportClaudeRefreshFailure({ workspaceId, slot: active.slot, caller, error })
		throw error
	}
	const { tokens: fresh, refreshed } = result
	if (refreshed) logger.info('Refreshed Claude OAuth token', { workspaceId, slot: active.slot })

	return { accessToken: fresh.accessToken, tokens: fresh }
}
