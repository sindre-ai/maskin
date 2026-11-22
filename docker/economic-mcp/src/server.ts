import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Credentials } from './client.js'
import { buildTools, explainFailure } from './tools.js'

/** One server per request: the tokens belong to that request only and are never stored. */
export function buildServer(credentials: Credentials | null): Server {
	const tools = new Map(buildTools(credentials).map((t) => [t.name, t]))
	const server = new Server(
		{ name: 'economic-mcp', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [...tools.values()].map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema as { type: 'object' },
		})),
	}))

	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
		const tool = tools.get(request.params.name)
		if (!tool) return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true }
		try {
			const result = await tool.handler(request.params.arguments ?? {})
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
		} catch (err) {
			return { content: [{ type: 'text', text: explainFailure(err) }], isError: true }
		}
	})

	return server
}
