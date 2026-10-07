import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_TOKEN_URL } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { type OAuthSlotKind, readSlots, resolveActiveSlot, writeSlot } from './claude-oauth-slots'
import { decrypt, encrypt } from './crypto'
import { logger } from './logger'

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
 * Refresh an expired access token using the refresh token.
 * Returns updated tokens (new access token, possibly new refresh token).
 */
export async function refreshClaudeToken(tokens: ClaudeOAuthTokens): Promise<ClaudeOAuthTokens> {
	const body = {
		grant_type: 'refresh_token',
		client_id: CLAUDE_OAUTH_CLIENT_ID,
		refresh_token: tokens.refreshToken,
	}

	const res = await fetch(CLAUDE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(CLAUDE_CREDENTIAL_TIMEOUT_MS),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Token refresh failed (${res.status}): ${text}`)
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
	bufferMs = 10 * 60 * 1000,
): Promise<{ tokens: ClaudeOAuthTokens; refreshed: boolean }> {
	if (stored.expiresAt > Date.now() + bufferMs) {
		return { tokens: decryptOAuthData(stored), refreshed: false }
	}
	return withSlotRefreshLock(`${workspaceId}:${slot}`, async () => {
		const readStored = async () => {
			const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
			const settings = (ws?.settings as Record<string, unknown>) ?? {}
			return readSlots(settings.claude_oauth)[slot]
		}
		const tokens = decryptOAuthData((await readStored()) ?? stored)
		try {
			const result = await refreshClaudeTokenIfNeeded(tokens, bufferMs)
			if (result.refreshed) {
				await persistRefreshedSlot(db, workspaceId, slot, encryptOAuthTokens(result.tokens))
			}
			return result
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
): Promise<{ accessToken: string; tokens: ClaudeOAuthTokens } | null> {
	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const wsSettings = (ws?.settings as Record<string, unknown>) ?? {}
	const active = resolveActiveSlot(wsSettings.claude_oauth)

	if (!active) return null

	const { tokens: fresh, refreshed } = await refreshSlotSingleFlight(
		db,
		workspaceId,
		active.slot,
		active.data,
		bufferMs,
	)
	if (refreshed) logger.info('Refreshed Claude OAuth token', { workspaceId, slot: active.slot })

	return { accessToken: fresh.accessToken, tokens: fresh }
}
