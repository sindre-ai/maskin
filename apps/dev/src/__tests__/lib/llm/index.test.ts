import { describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../../../lib/llm/anthropic'
import { createLLMAdapter } from '../../../lib/llm/index'
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

describe('createLLMAdapter extra_body', () => {
	it('passes extra_body to the OpenAI adapter request body', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
		})
		vi.stubGlobal('fetch', fetchMock)
		const adapter = createLLMAdapter('openai', {
			api_key: 'k',
			extra_body: { provider: { zdr: true } },
		})
		await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
		vi.unstubAllGlobals()
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider).toEqual({ zdr: true })
	})
})
