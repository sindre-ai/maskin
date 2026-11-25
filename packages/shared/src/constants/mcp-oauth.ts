// OAuth for the MCP server (Claude connector). Lifetimes are constants, not env.
// There is deliberately no absolute grant lifetime: a grant lives until it is
// revoked, its member is removed, or its refresh token goes unused for 30 days.
export const OAUTH_SCOPE = 'mcp'
export const OAUTH_ACCESS_TTL_S = 3600
export const OAUTH_REFRESH_TTL_S = 2592000
export const OAUTH_CODE_TTL_S = 60

export const OAUTH_ACCESS_TOKEN_PREFIX = 'mat_'
export const OAUTH_REFRESH_TOKEN_PREFIX = 'mrt_'

/** Claude's OAuth client. Clients are matched by exact string equality, no normalisation. */
export const MCP_OAUTH_CLAUDE_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'

/** ChatGPT's OAuth client: the address of its own client metadata document. */
export const MCP_OAUTH_CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json'

/** Shape of a pinned client record: what Claude publishes at its client_id URL. */
export interface PinnedMcpOAuthClient {
	client_id: string
	client_name: string
	client_uri: string
	redirect_uris: readonly string[]
	grant_types: readonly string[]
	response_types: readonly string[]
	token_endpoint_auth_method: string
}

/**
 * Pinned snapshot of Claude's client metadata document, verified live on 2026-10-13 10:51Z.
 * It is the only source for client_id, name and redirect URIs in v1: there is no live fetch.
 * grant_types lists the jwt-bearer URN too, which is tolerated, not required.
 * The scheduled drift check (scripts/checks/claude-client-drift.ts) compares this with the live
 * document and files an insight when they differ. It never changes what the server does.
 */
export const MCP_OAUTH_PINNED_CLAUDE_CLIENT: PinnedMcpOAuthClient = {
	client_id: MCP_OAUTH_CLAUDE_CLIENT_ID,
	client_name: 'Claude',
	client_uri: 'https://claude.ai',
	redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
	grant_types: [
		'authorization_code',
		'refresh_token',
		'urn:ietf:params:oauth:grant-type:jwt-bearer',
	],
	response_types: ['code'],
	token_endpoint_auth_method: 'none',
}

/**
 * Pinned snapshot of ChatGPT's client metadata document, read live on 2026-11-22 13:11Z. Same rules
 * as Claude's: no live fetch, the pin is the only source. ChatGPT publishes token_endpoint_auth_method
 * private_key_jwt as its default and lists none among the methods it supports. Maskin's
 * authorization server advertises only none, so none is what ChatGPT uses here and what is pinned.
 * grant_types lists the jwt-bearer URN too, which is tolerated, not required. The fixed return
 * address is the one OpenAI documents for a server that returns iss in its authorize response.
 */
export const MCP_OAUTH_PINNED_CHATGPT_CLIENT: PinnedMcpOAuthClient = {
	client_id: MCP_OAUTH_CHATGPT_CLIENT_ID,
	client_name: 'ChatGPT',
	client_uri: 'https://chatgpt.com/',
	redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
	grant_types: [
		'authorization_code',
		'refresh_token',
		'urn:ietf:params:oauth:grant-type:jwt-bearer',
	],
	response_types: ['code'],
	token_endpoint_auth_method: 'none',
}

/** Allowlist of pinned clients, keyed by client_id. Claude and ChatGPT. */
export const MCP_OAUTH_PINNED_CLIENTS: Readonly<Record<string, PinnedMcpOAuthClient>> = {
	[MCP_OAUTH_CLAUDE_CLIENT_ID]: MCP_OAUTH_PINNED_CLAUDE_CLIENT,
	[MCP_OAUTH_CHATGPT_CLIENT_ID]: MCP_OAUTH_PINNED_CHATGPT_CLIENT,
}
