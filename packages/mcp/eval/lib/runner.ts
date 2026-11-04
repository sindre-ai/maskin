import type { RunOutcome, TokenUsage } from './types'

// Runner: TypeScript query() from the Claude Agent SDK, with the Maskin MCP
// attached over HTTP. Agents have to come in over HTTP because only HTTP calls
// are classified into error rows. The harness key goes in the Authorization
// header and a fresh uuid goes in X-Maskin-Session-Id, so the server's tool_call
// and error rows for the run join to that uuid.
//
// Why not create_session: on main it takes no model and no config, and a local
// staging stack has no agent server to start an agent in. See README.md.

export interface AgentRunInput {
	prompt: string
	systemPrompt: string
	sessionId: string
	apiUrl: string
	workspaceId: string
	apiKey: string
	anthropicApiKey: string
	model: string
	maxTurns: number
	timeoutMs: number
}

// The few fields of the SDK's message stream the harness reads. Kept narrow so
// the runner can be tested with a fake stream and the SDK is loaded lazily.
interface SdkContentBlock {
	type: string
	is_error?: boolean
	/** tool_use: the call id and tool name. */
	id?: string
	name?: string
	/** tool_result: the id of the call it answers, and its text. */
	tool_use_id?: string
	content?: string | Array<{ type: string; text?: string }>
}
interface SdkModelUsage {
	inputTokens: number
	outputTokens: number
	cacheReadInputTokens: number
	cacheCreationInputTokens: number
	costUSD: number
}
export interface SdkMessage {
	type: string
	subtype?: string
	is_error?: boolean
	num_turns?: number
	total_cost_usd?: number
	modelUsage?: Record<string, SdkModelUsage>
	errors?: string[]
	message?: { content?: SdkContentBlock[] | string }
}

export type QueryFn = (params: {
	prompt: string
	options: Record<string, unknown>
}) => AsyncIterable<SdkMessage>

export async function loadQuery(): Promise<QueryFn> {
	const sdk = await import('@anthropic-ai/claude-agent-sdk')
	return sdk.query as unknown as QueryFn
}

export function buildQueryOptions(input: AgentRunInput, abortController: AbortController) {
	// Pay with the harness key, never with a logged-in subscription.
	const { CLAUDE_CODE_OAUTH_TOKEN: _subscription, ...inherited } = process.env
	const env = { ...inherited, ANTHROPIC_API_KEY: input.anthropicApiKey }
	return {
		model: input.model,
		systemPrompt: input.systemPrompt,
		maxTurns: input.maxTurns,
		abortController,
		env,
		// Only the Maskin MCP: no built-in tools, no settings files, no other MCP config.
		tools: [],
		settingSources: [],
		strictMcpConfig: true,
		mcpServers: {
			maskin: {
				type: 'http',
				url: `${input.apiUrl}/mcp`,
				headers: {
					Authorization: `Bearer ${input.apiKey}`,
					'X-Workspace-Id': input.workspaceId,
					'X-Maskin-Session-Id': input.sessionId,
				},
			},
		},
		allowedTools: ['mcp__maskin__*'],
		permissionMode: 'dontAsk',
	}
}

function sumUsage(modelUsage: Record<string, SdkModelUsage>): TokenUsage {
	const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }
	for (const entry of Object.values(modelUsage)) {
		usage.input += entry.inputTokens
		usage.output += entry.outputTokens
		usage.cacheRead += entry.cacheReadInputTokens
		usage.cacheCreation += entry.cacheCreationInputTokens
	}
	usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation
	return usage
}

const MCP_TOOL_PREFIX = 'mcp__maskin__'

function resultText(content: SdkContentBlock['content']): string {
	if (typeof content === 'string') return content
	return (content ?? []).map((part) => part.text ?? '').join(' ')
}

export async function runAgentSdk(input: AgentRunInput, query: QueryFn): Promise<RunOutcome> {
	const startedAt = Date.now()
	const abortController = new AbortController()
	const timer = setTimeout(() => abortController.abort(), input.timeoutMs)
	const outcome: RunOutcome = {
		runner: 'agent-sdk',
		model: input.model,
		costUsd: null,
		tokens: null,
		numTurns: null,
		clientToolUses: 0,
		clientToolErrors: 0,
		clientNotFoundByTool: {},
		finished: false,
		error: null,
		durationMs: 0,
	}
	const toolNameByCallId = new Map<string, string>()
	try {
		const stream = query({
			prompt: input.prompt,
			options: buildQueryOptions(input, abortController),
		})
		for await (const message of stream) {
			const content = message.message?.content
			if (message.type === 'assistant' && Array.isArray(content)) {
				for (const block of content) {
					if (block.type !== 'tool_use') continue
					outcome.clientToolUses += 1
					if (block.id && block.name) toolNameByCallId.set(block.id, block.name)
				}
			} else if (message.type === 'user' && Array.isArray(content)) {
				for (const block of content) {
					if (block.type !== 'tool_result' || block.is_error !== true) continue
					outcome.clientToolErrors += 1
					if (!/not found/i.test(resultText(block.content))) continue
					const name = (toolNameByCallId.get(block.tool_use_id ?? '') ?? 'unknown').replace(
						MCP_TOOL_PREFIX,
						'',
					)
					outcome.clientNotFoundByTool[name] = (outcome.clientNotFoundByTool[name] ?? 0) + 1
				}
			} else if (message.type === 'result') {
				outcome.finished = message.subtype === 'success' && message.is_error !== true
				outcome.numTurns = message.num_turns ?? null
				outcome.costUsd = message.total_cost_usd ?? null
				if (message.modelUsage) {
					outcome.tokens = sumUsage(message.modelUsage)
					outcome.model = Object.keys(message.modelUsage)[0] ?? null
				}
				if (!outcome.finished) {
					outcome.error = message.errors?.join('; ') || message.subtype || 'run did not succeed'
				}
			}
		}
	} catch (err) {
		outcome.error = abortController.signal.aborted
			? `timed out after ${input.timeoutMs} ms`
			: String(err)
	} finally {
		clearTimeout(timer)
		outcome.durationMs = Date.now() - startedAt
	}
	return outcome
}
