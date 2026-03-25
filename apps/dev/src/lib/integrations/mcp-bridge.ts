import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { LLMTool } from '../llm/adapter'
import { logger } from '../logger'

export interface McpBridgeSession {
	tools: LLMTool[]
	executeTool(name: string, args: Record<string, unknown>): Promise<string>
	close(): Promise<void>
}

export async function createMcpSession(
	command: string,
	args: string[],
	env: Record<string, string>,
): Promise<McpBridgeSession> {
	const transport = new StdioClientTransport({
		command,
		args,
		env: { ...process.env, ...env } as Record<string, string>,
	})

	const client = new Client({ name: 'ai-native-agent', version: '1.0.0' }, { capabilities: {} })

	await client.connect(transport)

	// List available tools from the MCP server
	const toolsResult = await client.listTools()
	const tools: LLMTool[] = (toolsResult.tools || []).map(
		(tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
			name: tool.name,
			description: tool.description || '',
			parameters: (tool.inputSchema as Record<string, unknown>) || {
				type: 'object',
				properties: {},
			},
		}),
	)

	logger.info(`MCP session started with ${tools.length} tools from ${command} ${args.join(' ')}`)

	return {
		tools,
		async executeTool(name: string, toolArgs: Record<string, unknown>): Promise<string> {
			const result = await client.callTool({ name, arguments: toolArgs })
			// MCP tool results are an array of content blocks
			const content = result.content as Array<{ type: string; text?: string }>
			return content
				.filter((c) => c.type === 'text' && c.text)
				.map((c) => c.text)
				.join('\n')
		},
		async close(): Promise<void> {
			try {
				await client.close()
			} catch (err) {
				logger.warn('MCP session close error', { error: String(err) })
			}
		},
	}
}
