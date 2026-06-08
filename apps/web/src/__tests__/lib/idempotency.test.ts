import { newIdempotencyKey } from '@/lib/idempotency'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('newIdempotencyKey', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('returns crypto.randomUUID() when available', () => {
		const uuid = '00000000-0000-4000-8000-000000000000'
		vi.stubGlobal('crypto', { randomUUID: () => uuid })
		expect(newIdempotencyKey()).toBe(uuid)
	})

	it('falls back to a timestamp-based string when randomUUID throws', () => {
		// Legacy iOS Safari, non-secure-context iframes, and some webviews
		// expose randomUUID but throw on call. The presence check alone would
		// let that throw bubble up into the caller's catch.
		vi.stubGlobal('crypto', {
			randomUUID: () => {
				throw new Error('SecurityError: insecure context')
			},
		})
		const key = newIdempotencyKey()
		expect(typeof key).toBe('string')
		expect(key.length).toBeGreaterThan(0)
		expect(key).toMatch(/^\d+-[a-z0-9]+$/)
	})

	it('falls back when crypto is undefined', () => {
		vi.stubGlobal('crypto', undefined)
		const key = newIdempotencyKey()
		expect(typeof key).toBe('string')
		expect(key).toMatch(/^\d+-[a-z0-9]+$/)
	})

	it('returns a different value on each call', () => {
		const a = newIdempotencyKey()
		const b = newIdempotencyKey()
		expect(a).not.toBe(b)
	})
})
