import { describe, expect, it, vi } from 'vitest'
import type { LLMAdapter } from '../../lib/llm/adapter'
import { RawSecretRefusedError, withSecretGuard } from '../../lib/llm/secret-guard'

// Obviously fake, assembled at runtime.
const fakeKey = `sk_live_${'z'.repeat(24)}`

function inner() {
	const chat = vi.fn(async () => ({
		content: 'ok',
		tool_calls: [],
		finish_reason: 'stop' as const,
	}))
	return { adapter: { chat } satisfies LLMAdapter, chat }
}

describe('withSecretGuard', () => {
	it('forwards messages with no secret', async () => {
		const { adapter, chat } = inner()
		await withSecretGuard(adapter).chat({
			model: 'm',
			messages: [{ role: 'user', content: 'hello' }],
		})
		expect(chat).toHaveBeenCalledOnce()
	})

	it('refuses a high-confidence match in any role and never calls the provider', async () => {
		for (const role of ['system', 'user', 'assistant', 'tool'] as const) {
			const { adapter, chat } = inner()
			await expect(
				withSecretGuard(adapter).chat({
					model: 'm',
					messages: [
						{ role: 'user', content: 'fine' },
						{ role, content: `here: ${fakeKey}` },
					],
				}),
			).rejects.toBeInstanceOf(RawSecretRefusedError)
			expect(chat).not.toHaveBeenCalled()
		}
	})

	it('names the pattern, never the matched text', async () => {
		const { adapter } = inner()
		const err = await withSecretGuard(adapter)
			.chat({ model: 'm', messages: [{ role: 'user', content: fakeKey }] })
			.catch((e: Error) => e)
		expect((err as Error).message).toContain('stripe')
		expect((err as Error).message).not.toContain(fakeKey)
	})

	it('lets the redaction marker through', async () => {
		const { adapter, chat } = inner()
		await withSecretGuard(adapter).chat({
			model: 'm',
			messages: [{ role: 'user', content: 'sk_live_[REDACTED · vaulted as NAME]' }],
		})
		expect(chat).toHaveBeenCalledOnce()
	})
})
