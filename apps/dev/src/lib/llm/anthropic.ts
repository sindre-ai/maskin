import type { LLMAdapter, LLMMessage, LLMResponse, LLMTool } from './adapter'

export class AnthropicAdapter implements LLMAdapter {
	private apiKey: string

	constructor(apiKey: string) {
		this.apiKey = apiKey
	}

	async chat(options: {
		model: string
		messages: LLMMessage[]
		tools?: LLMTool[]
		temperature?: number
	}): Promise<LLMResponse> {
		const systemMessage = options.messages.find((m) => m.role === 'system')
		const otherMessages = options.messages.filter((m) => m.role !== 'system')

		const body: Record<string, unknown> = {
			model: options.model || 'claude-sonnet-4-20250514',
			max_tokens: 4096,
			messages: otherMessages.map((m) => {
				if (m.role === 'tool') {
					return {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: m.tool_call_id,
								content: m.content,
							},
						],
					}
				}
				return { role: m.role, content: m.content }
			}),
		}

		if (systemMessage) {
			body.system = systemMessage.content
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

		const response = await fetch('https://api.anthropic.com/v1/messages', {
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
		const contentBlocks = (data.content ?? []) as Array<Record<string, unknown>>

		const toolCalls = contentBlocks
			.filter((block) => block.type === 'tool_use')
			.map((block) => ({
				id: block.id as string,
				name: block.name as string,
				arguments: block.input as Record<string, unknown>,
			}))

		const textContent = contentBlocks
			.filter((block) => block.type === 'text')
			.map((block) => block.text as string)
			.join('')

		return {
			content: textContent || null,
			tool_calls: toolCalls,
			finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
		}
	}
}
