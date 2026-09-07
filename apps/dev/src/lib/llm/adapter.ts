export interface LLMMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string
	tool_call_id?: string
}

export interface LLMToolCall {
	id: string
	name: string
	arguments: Record<string, unknown>
}

export interface LLMResponse {
	content: string | null
	tool_calls: LLMToolCall[]
	finish_reason: 'stop' | 'tool_calls' | 'length'
}

export interface LLMTool {
	name: string
	description: string
	parameters: Record<string, unknown> // JSON Schema
}

export interface LLMAdapter {
	chat(options: {
		model: string
		messages: LLMMessage[]
		tools?: LLMTool[]
		temperature?: number
		/** Caps the completion. Anthropic requires a value and defaults to
		 *  4096; OpenAI-shaped providers omit the field when unset. */
		max_tokens?: number
	}): Promise<LLMResponse>
}
