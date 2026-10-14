// Which MCP client family a request came from, for the `client` property on
// `mcp_tool_call`. Derived from the User-Agent header and nothing else.
//
// Privacy contract: the raw User-Agent is NEVER returned or stored. It carries
// OS and build versions, and it is self-reported, so the answer is a hint, not
// an identity. The output is one of a fixed set of labels, so no header value
// can reach analytics through this function.

export const MCP_CLIENTS = [
	'claude_code',
	'cursor',
	'vscode',
	'claude_desktop',
	'claude_ai',
	'other',
] as const

export type McpClient = (typeof MCP_CLIENTS)[number]

// Order matters: Cursor and VS Code both ship on Electron, so the specific
// names are tested before anything generic. `claude_desktop` is deliberately
// narrow: a bare /claude/ would also swallow Claude.ai's connector traffic,
// which has to stay `other` until its User-Agent has been observed in real
// data (see the tech spec's win-biasing risk).
const CLIENT_FAMILIES: ReadonlyArray<readonly [McpClient, RegExp]> = [
	['claude_code', /claude-cli|claude[ _-]code/i],
	['cursor', /cursor/i],
	['vscode', /vscode|visual studio code/i],
	['claude_desktop', /claude[ _-]?desktop|^claude\/[\d.]+.*electron/i],
]

export function classifyMcpClient(userAgent: string | null | undefined): McpClient {
	if (!userAgent) return 'other'
	for (const [client, pattern] of CLIENT_FAMILIES) {
		if (pattern.test(userAgent)) return client
	}
	return 'other'
}

// A Claude connector token names its client by the host of the client_id URL on its grant.
// Only allowlisted clients get a label of their own, so the grant can never inject free text.
const OAUTH_CLIENT_HOSTS: Readonly<Record<string, McpClient>> = {
	'claude.ai': 'claude_ai',
}

export function oauthClientLabel(clientId: string): McpClient {
	try {
		return OAUTH_CLIENT_HOSTS[new URL(clientId).hostname.toLowerCase()] ?? 'other'
	} catch {
		return 'other'
	}
}
