import type { ProviderConfig } from '../../types'

/**
 * Canva, through its hosted MCP server (https://mcp.canva.com/mcp). Like Notion's, it is its
 * own OAuth 2.1 authorization server, so the authorize and token URLs below are the MCP host's,
 * from its published metadata at /.well-known/oauth-authorization-server (checked 9 Nov 2026,
 * issuer https://mcp.canva.com). The scopes come from /.well-known/oauth-protected-resource.
 *
 * The client is registered once for Maskin's callback (`/api/integrations/canva/callback` on
 * each public origin) through Canva's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in CANVA_CLIENT_ID and
 * CANVA_CLIENT_SECRET.
 *
 * Scopes are read and write for designs, folders, brand templates, comments, assets and the
 * brand kit, plus the profile. The two help:answers scopes are left out: they are about Canva's
 * help centre, not the person's work. A read-only agent stays read-only at the MCP gateway
 * (GATEWAY_PROVIDERS), not through a narrower sign-in. Canva's revocation endpoint is the token
 * URL itself, which the handler's revoke call does not fit, so none is set. Tools carry no
 * curated read list: they are classified from the server's own annotations and names, and an
 * unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'canva',
	displayName: 'Canva',
	description: 'Read and edit Canva designs, folders and brand assets through the Canva MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.canva.com/authorize',
			tokenUrl: 'https://mcp.canva.com/token',
			scopes: [
				'profile:read',
				'design:meta:read',
				'design:content:read',
				'design:content:write',
				'folder:read',
				'folder:write',
				'brandtemplate:meta:read',
				'brandtemplate:content:read',
				'brandtemplate:content:write',
				'comment:read',
				'comment:write',
				'asset:read',
				'asset:write',
				'brandkit:read',
			],
			pkce: true,
			clientIdEnv: 'CANVA_CLIENT_ID',
			clientSecretEnv: 'CANVA_CLIENT_SECRET',
		},
	},

	// No webhook or events block: designs are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.canva.com/mcp'],
		envKey: 'CANVA_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.canva.com/mcp',
			headers: { Authorization: 'Bearer ${CANVA_TOKEN}' },
		},
	},
}
