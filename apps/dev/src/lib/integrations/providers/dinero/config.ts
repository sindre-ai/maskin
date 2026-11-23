import type { ProviderConfig } from '../../types'

export const DINERO_PROVIDER = 'dinero'

const MCP_URL = 'https://mcp.dinero.dk'

/**
 * Dinero, through Dinero's own hosted MCP server (https://mcp.dinero.dk, streamable HTTP, bearer
 * token; a Dinero Pro or Total feature). Its protected-resource metadata (checked 22 Nov 2026)
 * names https://dinero.oauth.connect.visma.com as the authorization server and lists the scopes
 * below. That server's metadata allows the code flow with refresh tokens, PKCE S256, and
 * client_secret_basic or client_secret_post, and publishes a registration address
 * (/connect/register, RFC 7591). Registration answered a bare POST without any credential, so no
 * Visma developer-portal step is needed: the client is registered once for Maskin's callback
 * (`/api/integrations/dinero/callback` on each public origin) with
 * scripts/register-oauth-client.mjs, and its id and secret live in DINERO_CLIENT_ID and
 * DINERO_CLIENT_SECRET. offline_access is what gives the refresh token, so the sign-in renews with
 * no person involved.
 *
 * Dinero's tools that book, change or delete sit on the same server as the one that saves a
 * purchase voucher as a draft. The gateway therefore limits every agent to a fixed list of tool
 * names (./allowed-tools.ts): reads and the draft tool, plus BookVoucher only when the owner's
 * booking switch is on. A tool not on the list is refused and left out of tools/list, whatever the
 * agent's access, so a Read & write agent cannot book, change or delete either.
 */
export const config: ProviderConfig = {
	name: DINERO_PROVIDER,
	displayName: 'Dinero',
	description:
		'Read Dinero organisations, accounts, vouchers and contacts. Needs a Dinero Pro or Total plan. Each owner signs in with their own Dinero user through Visma.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://dinero.oauth.connect.visma.com/connect/authorize',
			tokenUrl: 'https://dinero.oauth.connect.visma.com/connect/token',
			scopes: [
				'dinero_mcp:invoke_tools',
				'offline_access',
				'dineropublicapi:read',
				'dineropublicapi:write',
			],
			pkce: true,
			tokenAuthMethod: 'client_secret_basic',
			clientIdEnv: 'DINERO_CLIENT_ID',
			clientSecretEnv: 'DINERO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', MCP_URL],
		envKey: 'DINERO_TOKEN',
		server: {
			type: 'http',
			url: MCP_URL,
			headers: { Authorization: 'Bearer ${DINERO_TOKEN}' },
		},
	},
}
