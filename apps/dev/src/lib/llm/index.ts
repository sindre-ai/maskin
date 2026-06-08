import type { LLMAdapter } from './adapter'
import { OpenAIAdapter } from './openai'

export function createLLMAdapter(provider: string, config: Record<string, unknown>): LLMAdapter {
	switch (provider) {
		case 'openai':
			return new OpenAIAdapter(config.api_key as string, config.base_url as string | undefined)
		case 'ollama':
			return new OpenAIAdapter('ollama', (config.base_url as string) || 'http://localhost:11434/v1')
		default:
			throw new Error(`Unsupported LLM provider: ${provider}`)
	}
}

export type { LLMAdapter, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './adapter'
