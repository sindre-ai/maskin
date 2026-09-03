import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_PROFILE_URL, CLAUDE_TOKEN_URL } from '@maskin/shared'
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

/**
 * Who the subscription belongs to, as reported by Anthropic — not by us and
 * not by the customer. Displayed next to (never instead of) the user's own
 * `nickname`: one Anthropic account can be connected to several workspaces,
 * and a workspace may want to call it something else.
 */
export interface ClaudeAccountIdentity {
	email?: string
	organization?: string
	/** When we last read it from Anthropic. Also the "we already tried" flag. */
	fetchedAt: number
}

export interface ClaudeOAuthTokens {
	accessToken: string
	refreshToken: string
	expiresAt: number
	subscriptionType?: string
	scopes?: string[]
	nickname?: string
	account?: ClaudeAccountIdentity
}

interface TokenResponse {
	access_token: string
	refresh_token?: string
	expires_in: number
	scope?: string
	subscription_type?: string
	// Some OAuth token responses carry the identity alongside the tokens. Read
	// opportunistically — see `parseAccountIdentity`.
	account?: unknown
	organization?: unknown
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
		// A refresh response may restate the identity; if it doesn't, keep
		// what we already knew rather than forgetting it.
		account: parseAccountIdentity(data) ?? tokens.account,
	}
}

/**
 * Read Anthropic's account identity out of an arbitrary JSON body — either an
 * OAuth token response or the profile endpoint's. Returns `undefined` when
 * nothing recognisable is present, so an unexpected shape degrades to "we
 * don't know who this is" instead of throwing on the credential path.
 *
 * The accepted field names are deliberately generous: this reads an endpoint
 * whose response shape we do not control and cannot pin with a test against
 * real credentials.
 */
export function parseAccountIdentity(body: unknown): ClaudeAccountIdentity | undefined {
	if (typeof body !== 'object' || body === null) return undefined
	const root = body as Record<string, unknown>
	const account = (
		typeof root.account === 'object' && root.account !== null ? root.account : {}
	) as Record<string, unknown>
	const organization = (
		typeof root.organization === 'object' && root.organization !== null ? root.organization : {}
	) as Record<string, unknown>

	const pick = (...candidates: unknown[]): string | undefined => {
		for (const candidate of candidates) {
			if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
		}
		return undefined
	}

	const email = pick(
		account.email_address,
		account.email,
		account.emailAddress,
		root.email_address,
		root.email,
	)
	const org = pick(
		organization.name,
		organization.organization_name,
		root.organization_name,
		account.organization_name,
	)
	if (!email && !org) return undefined
	return { email, organization: org, fetchedAt: Date.now() }
}

/**
 * Ask Anthropic who a subscription token belongs to.
 *
 * Best-effort by construction: any failure — network, a non-2xx, a body we
 * don't recognise — returns `undefined`, because a missing display label must
 * never be the reason a credential can't be imported or a settings page can't
 * load. Bounded by the same timeout as every other credential-path call.
 *
 * The endpoint takes the subscription's OAuth access token as a bearer token
 * (its own 401 says so) and needs no additional scope beyond what the token
 * already carries.
 */
export async function fetchClaudeAccount(
	accessToken: string,
): Promise<ClaudeAccountIdentity | undefined> {
	try {
		const res = await fetch(CLAUDE_PROFILE_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'anthropic-beta': 'oauth-2025-04-20',
			},
			signal: AbortSignal.timeout(CLAUDE_CREDENTIAL_TIMEOUT_MS),
		})
		if (!res.ok) {
			logger.debug('Claude account profile lookup returned non-2xx', { status: res.status })
			return undefined
		}
		const body = (await res.json()) as unknown
		const identity = parseAccountIdentity(body)
		if (!identity) {
			// Log the KEYS only, never the values — enough to learn the shape
			// from a real workspace without putting anyone's email in a log.
			logger.debug('Claude account profile returned an unrecognised shape', {
				keys: typeof body === 'object' && body !== null ? Object.keys(body) : [],
			})
		}
		return identity
	} catch (err) {
		logger.debug('Claude account profile lookup failed', {
			error: err instanceof Error ? err.message : String(err),
		})
		return undefined
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
	account?: ClaudeAccountIdentity
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
		account: data.account,
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
		account: tokens.account,
	}
}

/**
 * Carry a slot's DISPLAY fields — the user's nickname and Anthropic's account
 * identity — from what is already stored onto a blob that is about to replace
 * it. Neither is token material: a write that only means to rotate credentials
 * must not silently erase how the credential is labelled.
 *
 * An incoming value always wins, so a rename or a fresh profile lookup still
 * takes effect; only `undefined` falls back to what was there.
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
	if (next.account === undefined && stored.account !== undefined) {
		next.account = stored.account
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
		// Second line of defence for the display fields: this function only ever
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

	const tokens = decryptOAuthData(active.data)
	const { tokens: fresh, refreshed } = await refreshClaudeTokenIfNeeded(tokens, bufferMs)

	if (refreshed) {
		await persistRefreshedSlot(db, workspaceId, active.slot, encryptOAuthTokens(fresh))
		logger.info('Refreshed Claude OAuth token', { workspaceId, slot: active.slot })
	}

	return { accessToken: fresh.accessToken, tokens: fresh }
}
