import type { LLMAdapter, LLMMessage, LLMResponse, LLMTool } from './adapter'

export class AnthropicAdapter implements LLMAdapter {
	private apiKey: string
	private baseUrl: string

	constructor(apiKey: string, baseUrl = 'https://api.anthropic.com') {
		this.apiKey = apiKey
		this.baseUrl = baseUrl
	}

	async chat(options: {
		model: string
		messages: LLMMessage[]
		tools?: LLMTool[]
		temperature?: number
	}): Promise<LLMResponse> {
		const systemMessages = options.messages.filter((m) => m.role === 'system')
		const nonSystemMessages = options.messages.filter((m) => m.role !== 'system')

		const body: Record<string, unknown> = {
			model: options.model || 'claude-sonnet-4-6',
			max_tokens: 4096,
			messages: nonSystemMessages.map((m) => ({
				role: m.role === 'tool' ? 'user' : m.role,
				content:
					m.role === 'tool'
						? [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]
						: m.content,
			})),
		}

		if (systemMessages.length > 0) {
			body.system = systemMessages.map((m) => m.content).join('\n')
		}

		if (options.tools?.length) {
			body.tools = options.tools.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}))
		}

		if (options.temperature !== undefined) {
			body.temperature = options.temperature
		}

		const response = await fetch(`${this.baseUrl}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const error = await response.text()
			throw new Error(`Anthropic API error: ${response.status} ${error}`)
		}

		const data = (await response.json()) as Record<string, unknown>
		const content = data.content as Array<Record<string, unknown>>

		const textContent = content.find((b) => b.type === 'text')
		const toolUseBlocks = content.filter((b) => b.type === 'tool_use')

		const toolCalls = toolUseBlocks.map((b) => ({
			id: b.id as string,
			name: b.name as string,
			arguments: b.input as Record<string, unknown>,
		}))

		const stopReason = data.stop_reason as string
		const finishReason = stopReason === 'tool_use' ? ('tool_calls' as const) : ('stop' as const)

		return {
			content: (textContent?.text as string) ?? null,
			tool_calls: toolCalls,
			finish_reason: finishReason,
		}
	}
}
