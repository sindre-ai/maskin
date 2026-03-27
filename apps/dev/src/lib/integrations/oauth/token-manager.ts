import type { Database } from '@ai-native/db'
import { integrations } from '@ai-native/db/schema'
import { eq } from 'drizzle-orm'
import { decrypt, encrypt } from '../../crypto'
import type { ResolvedProvider, StoredCredentials } from '../types'
import { OAuth2Handler } from './handler'

/** Buffer time before expiry to trigger a refresh (5 minutes) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000

export class TokenManager {
	/**
	 * Get a valid access token for an integration.
	 * Handles lazy refresh: if the token is about to expire and a refresh token
	 * is available, it will refresh and store the updated credentials.
	 */
	async getValidToken(
		db: Database,
		integrationId: string,
		provider: ResolvedProvider,
	): Promise<string> {
		// Read integration row
		const [integration] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, integrationId))
			.limit(1)

		if (!integration) {
			throw new Error(`Integration ${integrationId} not found`)
		}

		const credentials: StoredCredentials = JSON.parse(decrypt(integration.credentials))

		// Custom auth providers handle their own token generation
		if (provider.customAuth) {
			return provider.customAuth.getAccessToken(credentials)
		}

		// API key providers return the stored key directly
		if (provider.config.auth.type === 'api_key') {
			if (!credentials.accessToken) {
				throw new Error(`Integration ${integrationId} has no stored API key`)
			}
			return credentials.accessToken
		}

		// Standard OAuth2 flow
		if (!credentials.accessToken) {
			throw new Error(`Integration ${integrationId} has no access token`)
		}

		// No expiry set — token doesn't expire, return as-is
		if (!credentials.expiresAt) {
			return credentials.accessToken
		}

		// Token still valid — return as-is
		if (credentials.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
			return credentials.accessToken
		}

		// Token expired or about to expire — try to refresh
		if (!credentials.refreshToken) {
			throw new Error(
				`Integration ${integrationId} access token expired and no refresh token available. User must reconnect.`,
			)
		}

		if (provider.config.auth.type !== 'oauth2') {
			throw new Error(`Cannot refresh token for auth type: ${provider.config.auth.type}`)
		}

		const oauth2Config = provider.config.auth.config
		const handler = new OAuth2Handler(oauth2Config, provider.parseTokenResponse)
		const refreshed = await handler.refreshToken(credentials.refreshToken)

		// Merge: keep existing fields (like provider-specific data), override with refreshed tokens
		const updated: StoredCredentials = {
			...credentials,
			accessToken: refreshed.accessToken ?? credentials.accessToken,
			expiresAt: refreshed.expiresAt ?? credentials.expiresAt,
			scope: refreshed.scope ?? credentials.scope,
			tokenType: refreshed.tokenType ?? credentials.tokenType,
		}

		// Some providers return a new refresh token; update if present
		if (refreshed.refreshToken) {
			updated.refreshToken = refreshed.refreshToken
		}

		if (!updated.accessToken) {
			throw new Error(
				`Integration ${integrationId} token refresh did not return an access token. User must reconnect.`,
			)
		}

		// Store updated credentials
		await db
			.update(integrations)
			.set({
				credentials: encrypt(JSON.stringify(updated)),
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, integrationId))

		return updated.accessToken
	}
}
