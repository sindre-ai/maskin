import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { type McpConfig, createMcpServer } from './server.js'

async function main() {
	const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3000'
	const apiKey = process.env.API_KEY || ''
	const defaultWorkspaceId = process.env.DEFAULT_WORKSPACE_ID || process.env.WORKSPACE_ID || ''

	if (!apiKey) {
		console.error(
			'⚠️  API_KEY is not set. Calls to Maskin will fail. Set API_KEY=ank_... in your MCP client config.',
		)
	}

	const config: McpConfig = {
		apiBaseUrl,
		apiKey,
		defaultWorkspaceId,
		transport: 'stdio',
	}

	const server = createMcpServer(config)
	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error(`Maskin MCP server started (stdio) → ${apiBaseUrl}`)
}

main().catch((err) => {
	console.error('Fatal error starting Maskin MCP server:', err)
	process.exit(1)
})
