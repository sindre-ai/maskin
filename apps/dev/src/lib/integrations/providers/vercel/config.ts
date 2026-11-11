import type { ProviderConfig } from '../../types'

/**
 * Vercel, through its hosted MCP server (https://mcp.vercel.com). Sign-in is on a different host
 * from the tool server: the server's protected-resource metadata names https://vercel.com as its
 * authorization server, and the authorize and token URLs below are from that server's published
 * details at https://mcp.vercel.com/.well-known/oauth-authorization-server (checked 10 Nov 2026,
 * issuer https://vercel.com). It has a revocation endpoint, but nothing calls revoke today, so
 * none is set.
 *
 * Vercel only lets clients it has reviewed connect, or clients that identify themselves with a
 * Client ID Metadata Document (https://vercel.com/docs/agent-resources/vercel-mcp). Maskin uses
 * the document: the client id is an https address on Maskin that serves a small public JSON file
 * (routes/oauth-client-metadata.ts, `/oauth/client-metadata/vercel.json`). So VERCEL_CLIENT_ID is
 * that address on each public origin, not a registered id, and there is no secret: Vercel's token
 * endpoint takes auth method `none` only, so this is a public client with PKCE. Users still
 * approve each connection on Vercel's page.
 *
 * Vercel publishes no read or write scopes. `openid` is the one scope its tool server names, and
 * `offline_access` is what its sign-in offers for a refresh token. Read and write are enforced at
 * the MCP gateway (GATEWAY_PROVIDERS), not by a narrower sign-in. Vercel's tools can deploy code,
 * so they are classified from the server's own annotations and names, and a tool without a
 * read-only hint is a write.
 */
export const config: ProviderConfig = {
	name: 'vercel',
	displayName: 'Vercel',
	description: 'Read Vercel projects and deployments, and deploy, through the Vercel MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://vercel.com/oauth/authorize',
			tokenUrl: 'https://vercel.com/api/login/oauth/token',
			scopes: ['openid', 'offline_access'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'VERCEL_CLIENT_ID',
		},
	},

	// No webhook or events block: Vercel is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.vercel.com'],
		envKey: 'VERCEL_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.vercel.com',
			headers: { Authorization: 'Bearer ${VERCEL_TOKEN}' },
		},
	},
}
