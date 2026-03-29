import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../../../lib/llm/anthropic'

const mockFetch = vi.fn()

describe('AnthropicAdapter', () => {
	const adapter = new AnthropicAdapter('test-api-key')

	beforeEach(() => {
		global.fetch = mockFetch
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function mockOkResponse(data: Record<string, unknown>) {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(data),
		})
	}

	function mockErrorResponse(status: number, body: string) {
		mockFetch.mockResolvedValue({
			ok: false,
			status,
			text: () => Promise.resolve(body),
		})
	}

	it('sends correct headers', async () => {
		mockOkResponse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })

		await adapter.chat({ model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hello' }] })

		expect(mockFetch).toHaveBeenCalledWith(
			'https://api.anthropic.com/v1/messages',
			expect.objectContaining({
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'test-api-key',
					'anthropic-version': '2023-06-01',
				},
			}),
		)
	})

	it('uses default model when none provided', async () => {
		mockOkResponse({ content: [], stop_reason: 'end_turn' })

		await adapter.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] })

		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body.model).toBe('claude-sonnet-4-20250514')
	})

	it('uses provided model', async () => {
		mockOkResponse({ content: [], stop_reason: 'end_turn' })

		await adapter.chat({ model: 'claude-opus-4-20250514', messages: [{ role: 'user', content: 'hi' }] })

		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body.model).toBe('claude-opus-4-20250514')
	})

	it('separates system messages into body.system', async () => {
		mockOkResponse({ content: [], stop_reason: 'end_turn' })

		await adapter.chat({
			model: 'claude-sonnet-4-20250514',
			messages: [
				{ role: 'system', content: 'You are helpful' },
				{ role: 'user', content: 'hi' },
			],
		})

		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body.system).toBe('You are helpful')
		expect(body.messages).toHaveLength(1)
		expect(body.messages[0].role).toBe('user')
	})

	it('maps tool messages to tool_result content blocks', async () => {
		mockOkResponse({ content: [], stop_reason: 'end_turn' })

		await adapter.chat({
			model: 'claude-sonnet-4-20250514',
			messages: [
				{ role: 'user', content: 'hi' },
				{ role: 'tool', content: 'result data', tool_call_id: 'call-123' },
			],
		})

		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body.messages[1]).toEqual({
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'call-123',
					content: 'result data',
				},
			],
		})
	})

	it('maps tools to Anthropic format with input_schema', async () => {
		mockOkResponse({ content: [], stop_reason: 'end_turn' })

		await adapter.chat({
			model: 'claude-sonnet-4-20250514',
			messages: [{ role: 'user', content: 'hi' }],
			tools: [
				{
					name: 'get_weather',
					description: 'Get weather',
					parameters: { type: 'object', properties: { city: { type: 'string' } } },
				},
			],
		})

		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body.tools).toEqual([
			{
				name: 'get_weather',
				description: 'Get weather',
				input_schema: { type: 'object', properties: { city: { type: 'string' } } },
			},
		])
	})

	it('parses text response blocks', async () => {
		mockOkResponse({
			content: [
				{ type: 'text', text: 'Hello ' },
				{ type: 'text', text: 'world' },
			],
			stop_reason: 'end_turn',
		})

		const result = await adapter.chat({
			model: 'claude-sonnet-4-20250514',
			messages: [{ role: 'user', content: 'hi' }],
		})

		expect(result.content).toBe('Hello world')
	})

	it('parses tool_use response blocks', async () => {
		mockOkResponse({
			content: [
				{
					type: 'tool_use',
					id: 'tool-1',
					name: 'get_weather',
					input: { city: 'Oslo' },
				},
			],
			stop_reason: 'tool_use',
		})

		const result = await adapter.chat({
			model: 'claude-sonnet-4-20250514',
			messages: [{ role: 'user', content: 'weather?' }],
		})

		expect(result.tool_calls).toEqual([
			{ id: 'tool-1', name: 'get_weather', arguments: { city: 'Oslo' } },
		])
	})

	it('maps stop_reason tool_use to finish_reason tool_calls', async () => {
		mockOkResponse({ content: [], stop_reason: 'tool_use' })

		const result = await adapter.chat({
			model: 'claude-sonnet-4-20250514',
			messages: [{ role: 'user', content: 'hi' }],
		})

		expect(result.finish_reason).toBe('tool_calls')
	})

	it('maps stop_reason end_turn to finish_reason stop', async () => {
		mockOkResponse({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' })

		const result = await adapter.chat({
			model: 'claude-sonnet-4-20250514',
			messages: [{ role: 'user', content: 'hi' }],
		})

		expect(result.finish_reason).toBe('stop')
	})

	it('returns null content when no text blocks', async () => {
		mockOkResponse({ content: [], stop_reason: 'end_turn' })

		const result = await adapter.chat({
			model: 'claude-sonnet-4-20250514',
			messages: [{ role: 'user', content: 'hi' }],
		})

		expect(result.content).toBeNull()
	})

	it('throws on non-ok response', async () => {
		mockErrorResponse(429, 'Rate limited')

		await expect(
			adapter.chat({ model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toThrow('Anthropic API error: 429 Rate limited')
	})
})
