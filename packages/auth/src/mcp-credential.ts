import type { Database } from '@maskin/db'
import {
	OAUTH_ACCESS_TOKEN_PREFIX,
	OAUTH_REFRESH_TOKEN_PREFIX,
	type OauthAccessTokenContext,
} from '@maskin/shared'
import { validateApiKey } from './api-keys'
import { validateOAuthAccessToken } from './oauth-token'

/**
 * Kill switch for Claude connector tokens. Unset means off: a mat_ bearer is treated as
 * an unknown token format (today's 401) and nothing about API keys changes.
 */
export function isMcpOAuthEnabled(raw: string | undefined = process.env.MASKIN_MCP_OAUTH_ENABLED) {
	const value = raw?.trim().toLowerCase()
	return value === 'true' || value === '1'
}

export function isOAuthTokenPrefix(token: string): boolean {
	return token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) || token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)
}

export type McpCredential =
	| { kind: 'api_key'; actorId: string; actorType: string }
	| {
			kind: 'oauth'
			actorId: string
			actorType: string
			workspaceId: string
			grantId: string
			clientId: string
			scope: string
			resource: string
			expiresAt: Date
	  }

export interface McpCredentialLoaders {
	apiKey?: (token: string) => Promise<{ actorId: string; type: string } | null>
	oauth?: (token: string) => Promise<OauthAccessTokenContext | null>
}

/**
 * The one place that turns a bearer string into "who is calling". Used by authMiddleware
 * (for mat_ tokens, with cache-backed loaders) and by the /mcp route's telemetry label
 * (uncached), so the two cannot disagree about who a caller is.
 *
 * ank_ resolves through validateApiKey. mat_ resolves through validateOAuthAccessToken and
 * only when the kill switch is on. Anything else, including an mrt_ refresh token, is null.
 * For OAuth the workspace comes from the grant, never from a request header.
 */
export async function resolveMcpCredential(
	db: Database,
	bearer: string,
	loaders: McpCredentialLoaders = {},
): Promise<McpCredential | null> {
	if (bearer.startsWith('ank_')) {
		const found = await (loaders.apiKey ?? ((t) => validateApiKey(db, t)))(bearer)
		return found ? { kind: 'api_key', actorId: found.actorId, actorType: found.type } : null
	}
	if (bearer.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) && isMcpOAuthEnabled()) {
		const found = await (loaders.oauth ?? ((t) => validateOAuthAccessToken(db, t)))(bearer)
		if (!found) return null
		// A cache hit can be up to the cache TTL old, so the clock is re-checked here.
		if (found.expiresAt.getTime() <= Date.now()) return null
		return {
			kind: 'oauth',
			actorId: found.actorId,
			actorType: found.type,
			workspaceId: found.workspaceId,
			grantId: found.grantId,
			clientId: found.clientId,
			scope: found.scope,
			resource: found.resource,
			expiresAt: found.expiresAt,
		}
	}
	return null
}
