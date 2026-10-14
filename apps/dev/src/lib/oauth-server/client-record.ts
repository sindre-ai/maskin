import { MCP_OAUTH_PINNED_CLIENTS, type PinnedMcpOAuthClient } from '@maskin/shared'

export type ClientRecordError = 'client_not_allowlisted' | 'bad_redirect_uri'

export type ClientRecordResult =
	| { ok: true; client: PinnedMcpOAuthClient }
	| { ok: false; error: ClientRecordError }

/**
 * Whether a record can run the authorization code flow with PKCE and no client secret.
 * Extra values are tolerated: Claude's own document lists the jwt-bearer grant type, and a
 * strict subset check would reject it.
 */
export function supportsAuthorizationCodeFlow(client: PinnedMcpOAuthClient): boolean {
	return (
		client.grant_types.includes('authorization_code') &&
		client.response_types.includes('code') &&
		client.token_endpoint_auth_method === 'none'
	)
}

/**
 * Resolve a client from the pinned record. No network: an attacker-chosen client_id never causes
 * an outbound request. Checked in a fixed order: client_id first, then redirect_uri, both by exact
 * string equality (no normalisation, so a trailing dot or different case does not match).
 */
export function resolvePinnedClient(
	clientId: string,
	redirectUri: string,
	registry: Readonly<Record<string, PinnedMcpOAuthClient>> = MCP_OAUTH_PINNED_CLIENTS,
): ClientRecordResult {
	const client = Object.hasOwn(registry, clientId) ? registry[clientId] : undefined
	if (!client || client.client_id !== clientId || !supportsAuthorizationCodeFlow(client)) {
		return { ok: false, error: 'client_not_allowlisted' }
	}
	if (!client.redirect_uris.includes(redirectUri)) {
		return { ok: false, error: 'bad_redirect_uri' }
	}
	return { ok: true, client }
}
