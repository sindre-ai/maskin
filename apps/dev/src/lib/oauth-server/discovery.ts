import { OAUTH_SCOPE, resolveWebAppBaseUrl, stripTrailingSlash } from '@maskin/shared'

type DiscoveryEnv = Partial<Record<'MASKIN_OAUTH_ISSUER' | 'WEB_APP_URL' | 'FRONTEND_URL', string>>

/**
 * The origin Claude is told to sign in at. MASKIN_OAUTH_ISSUER when set (needed in local dev),
 * otherwise the origin people already type for /mcp. Computed per request, never hard-coded.
 */
export function resolveOAuthIssuer(env: DiscoveryEnv = process.env): string {
	const override = env.MASKIN_OAUTH_ISSUER?.trim()
	return override ? stripTrailingSlash(override) : resolveWebAppBaseUrl(env)
}

export function resolveMcpResource(env: DiscoveryEnv = process.env): string {
	return `${resolveOAuthIssuer(env)}/mcp`
}

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp'

/** RFC 9728 document, served at both well-known paths. */
export function buildProtectedResourceDocument(env: DiscoveryEnv = process.env) {
	return {
		resource: resolveMcpResource(env),
		authorization_servers: [resolveOAuthIssuer(env)],
		scopes_supported: [OAUTH_SCOPE],
		bearer_methods_supported: ['header'],
		resource_name: 'Maskin',
	}
}

/**
 * RFC 8414 document. There is no registration_endpoint on purpose. Claude falls back to dynamic
 * registration unless it sees both client_id_metadata_document_supported true and "none" in
 * token_endpoint_auth_methods_supported.
 */
export function buildAuthorizationServerDocument(env: DiscoveryEnv = process.env) {
	const issuer = resolveOAuthIssuer(env)
	return {
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/oauth/token`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		scopes_supported: [OAUTH_SCOPE],
		client_id_metadata_document_supported: true,
		authorization_response_iss_parameter_supported: true,
	}
}

/** WWW-Authenticate value for a 401 on /mcp. invalid_token is added for a bad Claude token. */
export function buildMcpChallenge(
	options: { invalidToken?: boolean } = {},
	env: DiscoveryEnv = process.env,
): string {
	const params: string[] = []
	if (options.invalidToken) {
		params.push(
			'error="invalid_token"',
			'error_description="The access token is invalid or expired"',
		)
	}
	params.push(
		`resource_metadata="${resolveOAuthIssuer(env)}${PROTECTED_RESOURCE_METADATA_PATH}"`,
		`scope="${OAUTH_SCOPE}"`,
	)
	return `Bearer ${params.join(', ')}`
}
