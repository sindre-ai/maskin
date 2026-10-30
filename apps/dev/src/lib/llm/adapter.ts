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

/**
 * Token counts exactly as the provider reported them. The four figures never
 * overlap: input_tokens excludes cached tokens, so a caller can price each
 * bucket at its own rate and add them up. All zero when the provider sends no
 * usage block.
 */
export interface LLMUsage {
	input_tokens: number
	output_tokens: number
	/** Input tokens written to the provider's prompt cache. */
	cache_creation_input_tokens: number
	/** Input tokens served from the provider's prompt cache. */
	cache_read_input_tokens: number
}

export interface LLMResponse {
	content: string | null
	tool_calls: LLMToolCall[]
	finish_reason: 'stop' | 'tool_calls' | 'length'
	usage: LLMUsage
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

/**
 * OpenRouter found no host that satisfies the request's provider preferences
 * (for example no zero-data-retention endpoint for the model). Distinct from
 * an outage so callers and alerts can tell a policy miss from a failure.
 */
export class LlmNoEligibleHostError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'LlmNoEligibleHostError'
	}
}
