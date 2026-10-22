import type { ProviderConfig } from '../../types'

/**
 * A custom MCP server a person added by hand (a command to run, or a URL to call),
 * shared with agents the same way an integration is: one row per server, and the
 * agents that may use it are its grants. It is never offered as something to
 * "connect" — the Integrations page adds and edits these in its own Tools section.
 *
 * The server definition (command, URL, env values, headers) is the encrypted
 * credentials blob; `config` holds only a non-secret summary. There is no `mcp`
 * block on purpose: the server is per row, so session launch reads it from the row.
 */
export const config: ProviderConfig = {
	name: 'custom-mcp',
	displayName: 'Custom tool server',
	description: 'An MCP server added by hand and shared with chosen agents',
	auth: { type: 'manual' },
}
