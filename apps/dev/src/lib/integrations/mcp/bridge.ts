import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { LLMTool } from '../../llm/adapter'
import { logger } from '../../logger'
import { fetchInstallationOwnerLogin } from '../providers/github/auth'
import { wrapGithubToolCall } from '../providers/github/error-tagger'
import { type TokenMetadata, stampTokenMetadata } from '../providers/github/token-metadata'

export interface McpBridgeSession {
	tools: LLMTool[]
	executeTool(name: string, args: Record<string, unknown>): Promise<string>
	close(): Promise<void>
}

/**
 * Provider-specific hook the bridge consults on every `executeTool` call.
 * When `provider === 'github'` and a `tokenMetadata` is present, the bridge
 * wraps the call in `wrapGithubToolCall` so any failure carries a classified
 * `cause_tag` per the parent bet's AC-6 glossary. Non-github providers are
 * untouched — the wrapper is github-scoped by design.
 */
export interface McpProviderContext {
	provider: string
	tokenMetadata?: TokenMetadata | null
	resolveInstallation?: (installationId: string) => Promise<boolean>
}

/**
 * Boolean adapter around `fetchInstallationOwnerLogin`. Returns `true` when
 * the installation still resolves against the App JWT, `false` on a 404
 * (App uninstalled or installation id rotated), and rethrows on any other
 * error so the wrapper doesn't silently interpret a network failure as an
 * install-ID rotation.
 */
export async function resolveInstallationExists(installationId: string): Promise<boolean> {
	try {
		await fetchInstallationOwnerLogin(installationId)
		return true
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (/Failed to fetch installation owner: 404\b/.test(msg)) {
			return false
		}
		throw err
	}
}

/**
 * Build a github provider context for the bridge from the credential path's
 * (token, installationId) pair. Stamps a fresh `TokenMetadata` so the wrapper
 * can tell `token-expired-mid-session` apart from a plain `401-unauth`, and
 * wires the install-ID resolve probe.
 */
export function buildGithubProviderContext(params: {
	token: string
	installationId: string
}): McpProviderContext {
	return {
		provider: 'github',
		tokenMetadata: stampTokenMetadata(params.token, params.installationId),
		resolveInstallation: resolveInstallationExists,
	}
}

export async function createMcpSession(
	command: string,
	args: string[],
	env: Record<string, string>,
	providerContext?: McpProviderContext,
): Promise<McpBridgeSession> {
	const transport = new StdioClientTransport({
		command,
		args,
		env: { ...process.env, ...env } as Record<string, string>,
	})

	const client = new Client({ name: 'maskin-agent', version: '1.0.0' }, { capabilities: {} })

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

	const isGithub = providerContext?.provider === 'github'
	const tokenMetadata = providerContext?.tokenMetadata ?? null
	const resolveInstallation = providerContext?.resolveInstallation

	const rawExecuteTool = async (
		name: string,
		toolArgs: Record<string, unknown>,
	): Promise<string> => {
		const result = await client.callTool({ name, arguments: toolArgs })
		// MCP tool results are an array of content blocks
		const content = result.content as Array<{ type: string; text?: string }>
		return content
			.filter((c) => c.type === 'text' && c.text)
			.map((c) => c.text)
			.join('\n')
	}

	return {
		tools,
		async executeTool(name: string, toolArgs: Record<string, unknown>): Promise<string> {
			if (!isGithub) {
				return rawExecuteTool(name, toolArgs)
			}
			return wrapGithubToolCall(() => rawExecuteTool(name, toolArgs), {
				toolName: name,
				tokenMeta: tokenMetadata,
				hadToken: Boolean(tokenMetadata?.token),
				resolveInstallation,
			})
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
