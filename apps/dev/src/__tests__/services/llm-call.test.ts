import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callLlm } from '../../services/llm-call'

describe('callLlm', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
		Reflect.deleteProperty(process.env, 'MASKIN_FALLBACK_OPENROUTER_KEY')
	})

	it('returns { ok: false, reason: "no_api_key" } when MASKIN_FALLBACK_OPENROUTER_KEY is unset', async () => {
		Reflect.deleteProperty(process.env, 'MASKIN_FALLBACK_OPENROUTER_KEY')
		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: false, reason: 'no_api_key' })
	})

	it('returns the LLM content on a 200 response', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ choices: [{ message: { content: '  hello world  ' } }] }),
			}),
		)

		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: true, content: 'hello world' })
	})

	it('returns { ok: false, reason: "http_error" } on a non-2xx response', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
		)

		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: false, reason: 'http_error', status: 503 })
	})

	it('sets response_format json_object when jsonMode is true', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: '{}' } }] }),
		})
		vi.stubGlobal('fetch', fetchMock)

		await callLlm({ system: 's', user: 'u', jsonMode: true })
		const [, init] = fetchMock.mock.calls[0]
		const body = JSON.parse((init as { body: string }).body)
		expect(body.response_format).toEqual({ type: 'json_object' })
	})

	it('returns { ok: false, reason: "exception" } when fetch throws', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: false, reason: 'exception' })
	})

	it('retries once on a transient exception (e.g. timeout) and returns the retry result', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
			})
		vi.stubGlobal('fetch', fetchMock)

		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: true, content: 'recovered' })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('retries once on a 5xx response before giving up', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
		vi.stubGlobal('fetch', fetchMock)

		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: false, reason: 'http_error', status: 503 })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('does not retry a 4xx client error', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) })
		vi.stubGlobal('fetch', fetchMock)

		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: false, reason: 'http_error', status: 400 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('retries once on an empty completion (e.g. reasoning consumed the whole token budget)', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ choices: [{ message: { content: '   ' } }] }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ choices: [{ message: { content: '{}' } }] }),
			})
		vi.stubGlobal('fetch', fetchMock)

		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: true, content: '{}' })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('returns empty content if every attempt comes back empty', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: '' } }] }),
		})
		vi.stubGlobal('fetch', fetchMock)

		const result = await callLlm({ system: 's', user: 'u' })
		expect(result).toEqual({ ok: true, content: '' })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	describe('zero-retention gate (MASKIN_FALLBACK_ZDR)', () => {
		const okResponse = {
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
		}

		function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
			const [, init] = fetchMock.mock.calls[0]
			return JSON.parse((init as { body: string }).body)
		}

		afterEach(() => {
			Reflect.deleteProperty(process.env, 'MASKIN_FALLBACK_ZDR')
		})

		it('sends no provider block when the flag is off (default)', async () => {
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
			const fetchMock = vi.fn().mockResolvedValue(okResponse)
			vi.stubGlobal('fetch', fetchMock)

			await callLlm({ system: 's', user: 'u' })
			expect(sentBody(fetchMock)).not.toHaveProperty('provider')
		})

		it.each(['true', '1'])(
			'sends provider: { zdr: true } on the funded key when the flag is %s',
			async (value) => {
				process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
				process.env.MASKIN_FALLBACK_ZDR = value
				const fetchMock = vi.fn().mockResolvedValue(okResponse)
				vi.stubGlobal('fetch', fetchMock)

				await callLlm({ system: 's', user: 'u' })
				expect(sentBody(fetchMock).provider).toEqual({ zdr: true })
			},
		)

		it('logs chat_zdr_no_eligible_host and returns the usual http_error without retrying on a no-endpoints 404', async () => {
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
			process.env.MASKIN_FALLBACK_ZDR = 'true'
			const fetchMock = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				text: async () => 'No endpoints found matching your data policy',
			})
			vi.stubGlobal('fetch', fetchMock)
			const errorSpy = vi.spyOn(console, 'error')

			const result = await callLlm({ system: 's', user: 'u' })
			expect(result).toEqual({ ok: false, reason: 'http_error', status: 404 })
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(JSON.stringify(errorSpy.mock.calls)).toContain('chat_zdr_no_eligible_host')
		})

		it('treats a 404 with other text as an ordinary http_error when the flag is on', async () => {
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
			process.env.MASKIN_FALLBACK_ZDR = 'true'
			const fetchMock = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				text: async () => 'model not found',
			})
			vi.stubGlobal('fetch', fetchMock)
			const errorSpy = vi.spyOn(console, 'error')

			const result = await callLlm({ system: 's', user: 'u' })
			expect(result).toEqual({ ok: false, reason: 'http_error', status: 404 })
			expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('chat_zdr_no_eligible_host')
		})
	})
})
