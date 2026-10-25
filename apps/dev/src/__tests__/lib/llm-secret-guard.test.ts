import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../../lib/llm/anthropic'
import { OpenAIAdapter } from '../../lib/llm/openai'
import { RawSecretRefusedError, assertNoRawSecrets } from '../../lib/llm/secret-guard'

// Obviously fake, assembled at runtime.
const fakeKey = `sk_live_${'z'.repeat(24)}`

afterEach(() => vi.unstubAllGlobals())

function stubFetch() {
	const fetchMock = vi.fn(async () => {
		throw new Error('the provider must not be called')
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

describe('assertNoRawSecrets', () => {
	it('passes ordinary messages and the redaction marker', () => {
		expect(() =>
			assertNoRawSecrets([
				{ content: 'hello' },
				{ content: 'sk_live_[REDACTED · vaulted as NAME]' },
			]),
		).not.toThrow()
	})

	it('names the pattern, never the matched text', () => {
		const err = (() => {
			try {
				assertNoRawSecrets([{ content: fakeKey }])
			} catch (e) {
				return e as Error
			}
		})()
		expect(err).toBeInstanceOf(RawSecretRefusedError)
		expect(err?.message).toContain('stripe')
		expect(err?.message).not.toContain(fakeKey)
	})
})

describe.each([
	['AnthropicAdapter', () => new AnthropicAdapter('key')],
	['OpenAIAdapter', () => new OpenAIAdapter('key')],
])('%s refuses a raw secret', (_name, make) => {
	it.each(['system', 'user', 'assistant', 'tool'] as const)(
		'in a %s message, as a rejected promise, without calling the provider',
		async (role) => {
			const fetchMock = stubFetch()
			const adapter = make()
			await expect(
				adapter.chat({
					model: 'm',
					messages: [
						{ role: 'user', content: 'fine' },
						{ role, content: `here: ${fakeKey}` },
					],
				}),
			).rejects.toBeInstanceOf(RawSecretRefusedError)
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it('still forwards a clean message', async () => {
		const fetchMock = stubFetch()
		await expect(
			make().chat({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }),
		).rejects.toThrow('the provider must not be called')
		expect(fetchMock).toHaveBeenCalledOnce()
	})
})
