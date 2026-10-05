import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmNoEligibleHostError } from '../../../lib/llm/adapter'
import { OpenAIAdapter } from '../../../lib/llm/openai'
import { logger } from '../../../lib/logger'

vi.mock('../../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

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
})

describe('OpenAIAdapter provider preferences', () => {
	const NO_ENDPOINTS =
		'{"error":{"message":"No endpoints found matching your data policy","code":404}}'
	const chatArgs = { model: 'deepseek/x', messages: [{ role: 'user' as const, content: 'hi' }] }
	const prefs = { provider: { zdr: true } }

	beforeEach(() => {
		vi.stubGlobal('fetch', mockFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		vi.clearAllMocks()
	})

	it('spreads extraBody into the request body', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
		})
		await new OpenAIAdapter('k', 'https://openrouter.ai/api/v1', prefs).chat(chatArgs)
		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body.provider).toEqual({ zdr: true })
		expect(body.model).toBe('deepseek/x')
	})

	it('sends no provider key without extraBody', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
		})
		await new OpenAIAdapter('k').chat(chatArgs)
		expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty('provider')
	})

	it('throws LlmNoEligibleHostError and logs the stable key on a 404 data-policy miss', async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve(NO_ENDPOINTS),
		})
		const err = await new OpenAIAdapter('k', 'https://openrouter.ai/api/v1', prefs)
			.chat(chatArgs)
			.catch((e) => e)
		expect(err).toBeInstanceOf(LlmNoEligibleHostError)
		expect(err.message).toContain('MASKIN_FALLBACK_ZDR')
		expect(logger.error).toHaveBeenCalledWith(
			'chat_zdr_no_eligible_host',
			expect.objectContaining({ body: NO_ENDPOINTS }),
		)
	})

	it('keeps the generic error for the same 404 when no preferences were sent', async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve(NO_ENDPOINTS),
		})
		const err = await new OpenAIAdapter('k').chat(chatArgs).catch((e) => e)
		expect(err).not.toBeInstanceOf(LlmNoEligibleHostError)
		expect(err.message).toBe(`OpenAI API error: 404 ${NO_ENDPOINTS}`)
		expect(logger.error).not.toHaveBeenCalled()
	})

	it('keeps the generic error for other failures when preferences were sent', async () => {
		mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') })
		const err = await new OpenAIAdapter('k', 'https://openrouter.ai/api/v1', prefs)
			.chat(chatArgs)
			.catch((e) => e)
		expect(err).not.toBeInstanceOf(LlmNoEligibleHostError)
		expect(err.message).toBe('OpenAI API error: 500 boom')
	})
})
