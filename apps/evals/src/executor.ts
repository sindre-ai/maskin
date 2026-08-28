import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { apiBaseUrl } from './api'

/**
 * Runs one tool call and returns what the model should see next.
 *
 * An interface rather than a concrete class so the environment under the
 * trajectory is swappable - today the real MCP server over the real database,
 * tomorrow a recorded or in-process one - without any case or grader changing.
 */
export interface ToolExecutor {
	call(name: string, input: Record<string, unknown>): Promise<ToolOutcome>
	close(): Promise<void>
}

export interface ToolOutcome {
	/** The text the tool returned, error text included. */
	text: string
	/** True when the server rejected the call (bad args, missing entity, ...). */
	isError: boolean
}

/**
 * Talks to a running apps/dev over MCP's Streamable HTTP transport, exactly as
 * a real agent does: `POST /mcp` with a Bearer API key and X-Workspace-Id.
 *
 * Going through the transport rather than calling handlers in-process is the
 * point. It means a call the real server would reject - a missing required
 * `workspace_id`, an `agent_id` that is not an agent - fails here too, so a
 * trajectory that "looks right" but could not have worked does not pass.
 */
export class McpExecutor implements ToolExecutor {
	private client: Client | null = null

	constructor(
		private readonly apiKey: string,
		private readonly workspaceId: string,
	) {}

	private async connect(): Promise<Client> {
		if (this.client) return this.client
		const client = new Client({ name: 'maskin-evals', version: '0.0.1' })
		const transport = new StreamableHTTPClientTransport(new URL('/mcp', apiBaseUrl()), {
			requestInit: {
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'X-Workspace-Id': this.workspaceId,
				},
			},
		})
		await client.connect(transport)
		this.client = client
		return client
	}

	async call(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
		const client = await this.connect()
		try {
			const result = await client.callTool({ name, arguments: input })
			const content = Array.isArray(result.content) ? result.content : []
			const text = content
				.map((block) =>
					typeof block === 'object' && block && 'text' in block ? String(block.text) : '',
				)
				.filter(Boolean)
				.join('\n')
			return { text: text || '(the tool returned no text)', isError: result.isError === true }
		} catch (err) {
			// A transport-level or protocol-level failure - an unknown tool name,
			// a schema rejection before the handler runs. The model sees it the
			// same way it would in production: as an error result it may recover
			// from, not as a crashed run.
			return { text: err instanceof Error ? err.message : String(err), isError: true }
		}
	}

	async close(): Promise<void> {
		await this.client?.close()
		this.client = null
	}
}
