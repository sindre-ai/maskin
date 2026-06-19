import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_TOKEN_URL } from '@maskin/shared'
import { eq, sql } from 'drizzle-orm'
import { decrypt, encrypt } from './crypto'
import { logger } from './logger'

export interface ClaudeOAuthTokens {
	accessToken: string
	refreshToken: string
	expiresAt: number
	subscriptionType?: string
	scopes?: string[]
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
	}
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
	const oauthData = wsSettings.claude_oauth as EncryptedOAuthData | undefined

	if (!oauthData?.encryptedAccessToken || !oauthData?.encryptedRefreshToken) {
		return null
	}

	const tokens = decryptOAuthData(oauthData)
	const { tokens: fresh, refreshed } = await refreshClaudeTokenIfNeeded(tokens, bufferMs)

	if (refreshed) {
		// Targeted JSONB update — only `claude_oauth` is touched. Refreshing the
		// token spans a network call, so any concurrent settings update (e.g. a
		// `max_concurrent_sessions` bump) would be clobbered if we read-modify-
		// wrote the whole settings object. `jsonb_set` mutates in-place at the
		// SQL level and is safe under concurrent writers.
		const encrypted = JSON.stringify(encryptOAuthTokens(fresh))
		await db
			.update(workspaces)
			.set({
				settings: sql`jsonb_set(coalesce(${workspaces.settings}, '{}'::jsonb), '{claude_oauth}', ${encrypted}::jsonb)`,
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))
		logger.info('Refreshed Claude OAuth token', { workspaceId })
	}

	return { accessToken: fresh.accessToken, tokens: fresh }
}
