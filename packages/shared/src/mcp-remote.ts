/**
 * The one stdio shape V1 attaches for a hosted MCP: npx mcp-remote <url>, with
 * the API key passed as an Authorization header. The key never appears in the
 * args: the header value is a placeholder for the env var the credential is
 * read into (envFromCredential, value "Bearer <key>"), expanded when the
 * server starts.
 */
export const MCP_REMOTE_AUTH_ENV = 'AUTHORIZATION'

export type McpRemoteServer = {
	type: 'stdio'
	command: 'npx'
	args: string[]
	envFromCredential?: string
}

export function mcpRemoteServer(url: string, withApiKey: boolean): McpRemoteServer {
	return withApiKey
		? {
				type: 'stdio',
				command: 'npx',
				args: ['mcp-remote', url, '--header', `Authorization:\${${MCP_REMOTE_AUTH_ENV}}`],
				envFromCredential: MCP_REMOTE_AUTH_ENV,
			}
		: { type: 'stdio', command: 'npx', args: ['mcp-remote', url] }
}

/** The server URL inside a stored mcp-remote server, or null for any other shape. */
export function mcpRemoteUrl(server: { type: string; command?: string; args?: string[] }): string | null {
	if (server.type !== 'stdio' || server.command !== 'npx') return null
	const [pkg, url] = server.args ?? []
	return pkg === 'mcp-remote' && url ? url : null
}
