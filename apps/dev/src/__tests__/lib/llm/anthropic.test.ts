import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../../../lib/llm/anthropic'

const mockFetch = vi.fn()

describe('AnthropicAdapter usage', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', mockFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	function mockOkResponse(data: Record<string, unknown>) {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(data),
		})
	}

	const chat = () =>
		new AnthropicAdapter('sk-ant-test').chat({
			model: 'claude-sonnet-5-5',
			messages: [{ role: 'user', content: 'hi' }],
		})

	it('reads input and output tokens from the provider usage block', async () => {
		mockOkResponse({
			content: [{ type: 'text', text: 'hello' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 120, output_tokens: 45 },
		})

		const result = await chat()

		expect(result.content).toBe('hello')
		expect(result.usage).toEqual({
			input_tokens: 120,
			output_tokens: 45,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		})
	})

	it('reads cache creation and cache read tokens', async () => {
		mockOkResponse({
			content: [{ type: 'text', text: 'hello' }],
			stop_reason: 'end_turn',
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_creation_input_tokens: 2000,
				cache_read_input_tokens: 8000,
			},
		})

		const result = await chat()

		expect(result.usage).toEqual({
			input_tokens: 10,
			output_tokens: 5,
			cache_creation_input_tokens: 2000,
			cache_read_input_tokens: 8000,
		})
	})

	it('returns zeros when the provider sends no usage block', async () => {
		mockOkResponse({
			content: [{ type: 'text', text: 'hello' }],
			stop_reason: 'end_turn',
		})

		const result = await chat()

		expect(result.usage).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		})
	})

	it('treats null or non-numeric usage figures as zero', async () => {
		mockOkResponse({
			content: [{ type: 'text', text: 'hello' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: null, output_tokens: '7', cache_read_input_tokens: 3 },
		})

		const result = await chat()

		expect(result.usage).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 3,
		})
	})
})

describe('AnthropicAdapter tool-call round trip', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', mockFetch)
		mockFetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
		})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('sends the assistant tool calls as tool_use and folds the results into one user message', async () => {
		await new AnthropicAdapter('sk-ant-test').chat({
			model: 'claude-sonnet-5-5',
			messages: [
				{ role: 'user', content: 'question' },
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{ id: 't1', name: 'web_search', arguments: { query: 'a' } },
						{ id: 't2', name: 'web_search', arguments: { query: 'b' } },
					],
				},
				{ role: 'tool', content: 'result a', tool_call_id: 't1' },
				{ role: 'tool', content: 'result b', tool_call_id: 't2' },
			],
		})

		const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1].body))
		expect(body.messages).toEqual([
			{ role: 'user', content: 'question' },
			{
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'a' } },
					{ type: 'tool_use', id: 't2', name: 'web_search', input: { query: 'b' } },
				],
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 't1', content: 'result a' },
					{ type: 'tool_result', tool_use_id: 't2', content: 'result b' },
				],
			},
		])
	})
})
