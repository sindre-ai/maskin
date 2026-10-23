// Which MCP client family a request came from, for the `client` property on
// `mcp_tool_call`. Derived from the User-Agent header and nothing else.
//
// Privacy contract: the raw User-Agent is NEVER returned or stored. It carries
// OS and build versions, and it is self-reported, so the answer is a hint, not
// an identity. The output is one of a fixed set of labels, so no header value
// can reach analytics through this function.

export const MCP_CLIENTS = ['claude_code', 'cursor', 'vscode', 'claude_desktop', 'other'] as const

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
