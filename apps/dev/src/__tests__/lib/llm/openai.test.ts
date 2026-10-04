import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmNoEligibleHostError } from '../../../lib/llm/adapter'
import { OpenAIAdapter } from '../../../lib/llm/openai'
import { logger } from '../../../lib/logger'

const mockFetch = vi.fn()

describe('OpenAIAdapter', () => {
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

	function mockErrorResponse(status: number, body: string) {
		mockFetch.mockResolvedValue({
			ok: false,
			status,
			text: () => Promise.resolve(body),
		})
	}

	function makeTextResponse(content: string, finishReason = 'stop') {
		return {
			choices: [
				{
					message: { content, tool_calls: undefined },
					finish_reason: finishReason,
				},
			],
		}
	}

	it('sends correct headers with Authorization Bearer', async () => {
		const adapter = new OpenAIAdapter('sk-test-key')
		mockOkResponse(makeTextResponse('hi'))

		await adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] })

		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: {
					'Content-Type': 'application/json',
					Authorization: 'Bearer sk-test-key',
				},
			}),
		)
	})

	it('uses default model and baseUrl', async () => {
		const adapter = new OpenAIAdapter('sk-test')
		mockOkResponse(makeTextResponse('hi'))

		await adapter.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] })

		expect(mockFetch).toHaveBeenCalledWith(
			'https://api.openai.com/v1/chat/completions',
			expect.any(Object),
		)
		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body.model).toBe('gpt-4o')
	})

	it('uses custom baseUrl', async () => {
		const adapter = new OpenAIAdapter('key', 'http://localhost:11434/v1')
		mockOkResponse(makeTextResponse('hi'))

		await adapter.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] })

		expect(mockFetch).toHaveBeenCalledWith(
			'http://localhost:11434/v1/chat/completions',
			expect.any(Object),
		)
	})

	it('maps messages with tool_call_id', async () => {
		const adapter = new OpenAIAdapter('sk-test')
		mockOkResponse(makeTextResponse('ok'))

		await adapter.chat({
			model: 'gpt-4o',
			messages: [
				{ role: 'user', content: 'hi' },
				{ role: 'tool', content: 'result', tool_call_id: 'call-1' },
			],
		})

		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body.messages[1]).toEqual({
			role: 'tool',
			content: 'result',
			tool_call_id: 'call-1',
		})
	})

	it('maps tools to OpenAI function format', async () => {
		const adapter = new OpenAIAdapter('sk-test')
		mockOkResponse(makeTextResponse('ok'))

		await adapter.chat({
			model: 'gpt-4o',
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
				type: 'function',
				function: {
					name: 'get_weather',
					description: 'Get weather',
					parameters: { type: 'object', properties: { city: { type: 'string' } } },
				},
			},
		])
	})

	it('parses text-only response', async () => {
		const adapter = new OpenAIAdapter('sk-test')
		mockOkResponse(makeTextResponse('Hello world'))

		const result = await adapter.chat({
			model: 'gpt-4o',
			messages: [{ role: 'user', content: 'hi' }],
		})

		expect(result.content).toBe('Hello world')
		expect(result.tool_calls).toEqual([])
	})

	it('parses tool call response with JSON.parse on arguments', async () => {
		const adapter = new OpenAIAdapter('sk-test')
		mockOkResponse({
			choices: [
				{
					message: {
						content: null,
						tool_calls: [
							{
								id: 'call-1',
								function: {
									name: 'get_weather',
									arguments: '{"city":"Oslo"}',
								},
							},
						],
					},
					finish_reason: 'tool_calls',
				},
			],
		})

		const result = await adapter.chat({
			model: 'gpt-4o',
			messages: [{ role: 'user', content: 'weather?' }],
		})

		expect(result.tool_calls).toEqual([
			{ id: 'call-1', name: 'get_weather', arguments: { city: 'Oslo' } },
		])
	})

	it('maps finish_reason correctly', async () => {
		const adapter = new OpenAIAdapter('sk-test')
		mockOkResponse({
			choices: [
				{
					message: {
						content: null,
						tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{}' } }],
					},
					finish_reason: 'tool_calls',
				},
			],
		})

		const result = await adapter.chat({
			model: 'gpt-4o',
			messages: [{ role: 'user', content: 'hi' }],
		})

		expect(result.finish_reason).toBe('tool_calls')
	})

	it('throws on non-ok response', async () => {
		const adapter = new OpenAIAdapter('sk-test')
		mockErrorResponse(500, 'Internal error')

		await expect(
			adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toThrow('OpenAI API error: 500 Internal error')
	})

	it('throws when no choices returned', async () => {
		const adapter = new OpenAIAdapter('sk-test')
		mockOkResponse({ choices: [] })

		await expect(
			adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toThrow('OpenAI returned no choices in response')
	})

	describe('extraBody', () => {
		const chatOptions = {
			model: 'deepseek/x',
			messages: [{ role: 'user' as const, content: 'hi' }],
		}
		const sentBody = () => JSON.parse(mockFetch.mock.calls[0][1].body as string)

		it('spreads extraBody into the request body', async () => {
			const adapter = new OpenAIAdapter('sk-or', 'https://openrouter.ai/api/v1', {
				provider: { zdr: true },
			})
			mockOkResponse(makeTextResponse('hi'))

			await adapter.chat(chatOptions)

			expect(sentBody().provider).toEqual({ zdr: true })
			expect(sentBody().model).toBe('deepseek/x')
		})

		it('sends no provider key when extraBody is not set', async () => {
			const adapter = new OpenAIAdapter('sk-test')
			mockOkResponse(makeTextResponse('hi'))

			await adapter.chat(chatOptions)

			expect(sentBody()).not.toHaveProperty('provider')
		})

		it('throws LlmNoEligibleHostError on a no-endpoints 404 when provider prefs are set', async () => {
			const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {})
			const body = '{"error":{"message":"No endpoints found matching your data policy","code":404}}'
			const adapter = new OpenAIAdapter('sk-or', 'https://openrouter.ai/api/v1', {
				provider: { zdr: true },
			})
			mockErrorResponse(404, body)

			await expect(adapter.chat(chatOptions)).rejects.toBeInstanceOf(LlmNoEligibleHostError)
			expect(errorLog).toHaveBeenCalledWith(
				'chat_zdr_no_eligible_host',
				expect.objectContaining({ body }),
			)
		})

		it('keeps the generic error for a 404 when no provider prefs are set', async () => {
			const adapter = new OpenAIAdapter('sk-or')
			mockErrorResponse(404, 'No endpoints found matching your data policy')

			const err = await adapter.chat(chatOptions).catch((e) => e)

			expect(err).not.toBeInstanceOf(LlmNoEligibleHostError)
			expect(err.message).toContain('OpenAI API error: 404')
		})

		it('keeps the generic error for other failures when provider prefs are set', async () => {
			const adapter = new OpenAIAdapter('sk-or', 'https://openrouter.ai/api/v1', {
				provider: { zdr: true },
			})
			mockErrorResponse(500, 'Internal error')

			const err = await adapter.chat(chatOptions).catch((e) => e)

			expect(err).not.toBeInstanceOf(LlmNoEligibleHostError)
			expect(err.message).toContain('OpenAI API error: 500')
		})
	})
})
