import { describe, expect, it } from 'vitest'
import { createLLMAdapter } from '../../../lib/llm/index'
import { AnthropicAdapter } from '../../../lib/llm/anthropic'
import { OpenAIAdapter } from '../../../lib/llm/openai'

describe('createLLMAdapter', () => {
	it('returns AnthropicAdapter for anthropic provider', () => {
		const adapter = createLLMAdapter('anthropic', { api_key: 'sk-ant-test' })
		expect(adapter).toBeInstanceOf(AnthropicAdapter)
	})

	it('returns OpenAIAdapter for openai provider', () => {
		const adapter = createLLMAdapter('openai', { api_key: 'sk-test' })
		expect(adapter).toBeInstanceOf(OpenAIAdapter)
	})

	it('returns OpenAIAdapter with localhost:11434 for ollama provider', () => {
		const adapter = createLLMAdapter('ollama', {})
		expect(adapter).toBeInstanceOf(OpenAIAdapter)
	})

	it('throws for unknown provider', () => {
		expect(() => createLLMAdapter('unknown', {})).toThrow('Unsupported LLM provider: unknown')
	})
})
