import { newIdempotencyKey } from '@/lib/idempotency'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('newIdempotencyKey', () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('uses crypto.randomUUID when available', () => {
		const spy = vi
			.spyOn(crypto, 'randomUUID')
			.mockReturnValue(
				'00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
			)

		expect(newIdempotencyKey()).toBe('00000000-0000-0000-0000-000000000001')
		expect(spy).toHaveBeenCalledTimes(1)
	})

	it('returns the same value on a single call (callers cache it for double-taps)', () => {
		const value = newIdempotencyKey()
		expect(value).toMatch(/^[0-9a-f-]+$|^\d+-/i)
		expect(value.length).toBeGreaterThan(0)
	})

	it('falls back to a unique key when crypto.randomUUID throws', () => {
		// Legacy iOS Safari / non-secure-context webview: the property exists but
		// calling it throws `NotSupportedError`. Presence-check guards miss this.
		vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
			throw new DOMException('Not supported', 'NotSupportedError')
		})

		const key = newIdempotencyKey()
		expect(key).toMatch(/^\d+-[a-z0-9]+$/)
	})

	it('produces distinct fallback keys across calls', () => {
		vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
			throw new Error('boom')
		})

		const keys = new Set([newIdempotencyKey(), newIdempotencyKey(), newIdempotencyKey()])
		expect(keys.size).toBe(3)
	})
})
