import type { LLMAdapter, LLMMessage, LLMResponse, LLMTool } from './adapter'

export class OpenAIAdapter implements LLMAdapter {
	private apiKey: string
	private baseUrl: string

	constructor(apiKey: string, baseUrl = 'https://api.openai.com/v1') {
		this.apiKey = apiKey
		this.baseUrl = baseUrl
	}

	async chat(options: {
		model: string
		messages: LLMMessage[]
		tools?: LLMTool[]
		temperature?: number
	}): Promise<LLMResponse> {
		const body: Record<string, unknown> = {
			model: options.model || 'gpt-4o',
			messages: options.messages.map((m) => ({
				role: m.role,
				content: m.content,
				...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
			})),
		}

		if (options.tools?.length) {
			body.tools = options.tools.map((t) => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}))
		}

		if (options.temperature !== undefined) {
			body.temperature = options.temperature
		}

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const error = await response.text()
			throw new Error(`OpenAI API error: ${response.status} ${error}`)
		}

		const data = (await response.json()) as Record<string, unknown>
		const choices = data.choices as Array<Record<string, unknown>>
		const choice = choices[0]
		if (!choice) {
			throw new Error('OpenAI returned no choices in response')
		}
		const message = choice.message as Record<string, unknown>

		const rawToolCalls = (message.tool_calls ?? []) as Array<Record<string, unknown>>
		const toolCalls = rawToolCalls.map((tc) => {
			const fn = tc.function as Record<string, unknown>
			return {
				id: tc.id as string,
				name: fn.name as string,
				arguments: JSON.parse(fn.arguments as string) as Record<string, unknown>,
			}
		})

		return {
			content: (message.content as string) ?? null,
			tool_calls: toolCalls,
			finish_reason:
				(choice.finish_reason as string) === 'tool_calls'
					? ('tool_calls' as const)
					: ('stop' as const),
		}
	}
}
