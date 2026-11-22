import type { ProviderConfig } from '../../types'

export const LATTICE_PROVIDER = 'lattice'

const MCP_URL = 'https://api.latticehq.com/mcp'

/**
 * Lattice, through its hosted MCP server (https://api.latticehq.com/mcp). Its protected-resource
 * metadata names https://api-auth.latticehq.com as the authorization server, and the URLs and
 * scopes below are from that metadata and from the server's published details at
 * /.well-known/oauth-authorization-server (both read live on 22 Nov 2026).
 *
 * Lattice has no dynamic client registration (its MCP FAQ says clients are created by hand). A
 * customer's Lattice Integrations Admin creates the client and pastes its id and secret into
 * Settings. That is customerApp: the workspace's own app is read at sign-in and at refresh, and
 * there is no Maskin-owned Lattice app. LATTICE_CLIENT_ID and LATTICE_CLIENT_SECRET are an optional
 * server-wide fallback and are normally unset.
 *
 * We ask for every scope the server lists plus offline_access, which the authorization server
 * lists for refresh tokens. What an agent may do is still decided per agent in Maskin. Not yet
 * tried against a live Lattice sign-in, so whether a client must have each scope enabled in
 * Lattice first is unverified.
 */
export const config: ProviderConfig = {
	name: LATTICE_PROVIDER,
	displayName: 'Lattice',
	description:
		'Read and update people, goals, reviews, feedback and meetings in Lattice. Your Lattice admin creates an app once and you paste its client ID and secret here.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://api-auth.latticehq.com/oauth2/auth',
			tokenUrl: 'https://api-auth.latticehq.com/oauth2/token',
			revokeUrl: 'https://api-auth.latticehq.com/oauth2/revoke',
			scopes: [
				'offline_access',
				'mcp:employees.read',
				'mcp:feedback.read',
				'mcp:feedback.write',
				'mcp:goals.read',
				'mcp:goals.write',
				'mcp:grow.read',
				'mcp:meetings.read',
				'mcp:meetings.write',
				'mcp:reviews.read',
				'mcp:reviews.write',
				'mcp:surveys.read',
				'mcp:updates.read',
				'mcp:updates.write',
			],
			pkce: true,
			tokenAuthMethod: 'client_secret_post',
			customerApp: true,
			clientIdEnv: 'LATTICE_CLIENT_ID',
			clientSecretEnv: 'LATTICE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read and changed on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', MCP_URL],
		envKey: 'LATTICE_TOKEN',
		server: {
			type: 'http',
			url: MCP_URL,
			headers: { Authorization: 'Bearer ${LATTICE_TOKEN}' },
		},
	},
}
