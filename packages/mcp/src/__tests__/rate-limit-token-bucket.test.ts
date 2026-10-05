import { describe, expect, it } from 'vitest'
import { createKeyedTokenBucket } from '../rate-limit/token-bucket'

function setup(capacity = 250, windowMs = 60_000) {
	let clock = 1_000_000
	const bucket = createKeyedTokenBucket({ capacity, windowMs, now: () => clock })
	return {
		bucket,
		advance: (ms: number) => {
			clock += ms
		},
	}
}

describe('createKeyedTokenBucket', () => {
	it('allows exactly `capacity` takes in a burst and denies the next one', () => {
		const { bucket } = setup()
		for (let i = 0; i < 250; i++) {
			expect(bucket.take('ws-a').allowed).toBe(true)
		}
		const denied = bucket.take('ws-a')
		expect(denied.allowed).toBe(false)
	})

	it('reports remaining tokens after each allowed take', () => {
		const { bucket } = setup(3, 60_000)
		expect(bucket.take('ws-a')).toEqual({ allowed: true, remaining: 2 })
		expect(bucket.take('ws-a')).toEqual({ allowed: true, remaining: 1 })
		expect(bucket.take('ws-a')).toEqual({ allowed: true, remaining: 0 })
	})

	it('reports how long until one token is available when denied', () => {
		const { bucket, advance } = setup(250, 60_000)
		for (let i = 0; i < 250; i++) bucket.take('ws-a')
		// 250 per 60s refills one token every 240ms.
		expect(bucket.take('ws-a')).toEqual({ allowed: false, retryAfterMs: 240 })
		advance(100)
		expect(bucket.take('ws-a')).toEqual({ allowed: false, retryAfterMs: 140 })
	})

	it('admits a call again once the retry delay has passed', () => {
		const { bucket, advance } = setup(250, 60_000)
		for (let i = 0; i < 250; i++) bucket.take('ws-a')
		advance(240)
		expect(bucket.take('ws-a').allowed).toBe(true)
		expect(bucket.take('ws-a').allowed).toBe(false)
	})

	it('refills a drained bucket in full after the window and never above capacity', () => {
		const { bucket, advance } = setup(5, 60_000)
		for (let i = 0; i < 5; i++) bucket.take('ws-a')
		advance(10 * 60_000)
		for (let i = 0; i < 5; i++) {
			expect(bucket.take('ws-a').allowed).toBe(true)
		}
		expect(bucket.take('ws-a').allowed).toBe(false)
	})

	it('keeps keys independent', () => {
		const { bucket } = setup(2, 60_000)
		bucket.take('ws-a')
		bucket.take('ws-a')
		expect(bucket.take('ws-a').allowed).toBe(false)
		expect(bucket.take('ws-b')).toEqual({ allowed: true, remaining: 1 })
	})

	it('spends a custom cost and reports the wait for the shortfall', () => {
		const { bucket } = setup(10, 10_000)
		expect(bucket.take('ws-a', 8)).toEqual({ allowed: true, remaining: 2 })
		// Needs 5, has 2: 3 tokens short at 1 token per 1000ms.
		expect(bucket.take('ws-a', 5)).toEqual({ allowed: false, retryAfterMs: 3000 })
	})

	it('does not spend tokens on a denied take', () => {
		const { bucket, advance } = setup(2, 2_000)
		bucket.take('ws-a', 2)
		bucket.take('ws-a')
		advance(1_000)
		expect(bucket.take('ws-a')).toEqual({ allowed: true, remaining: 0 })
	})

	it('rejects non-positive options and out-of-range costs', () => {
		expect(() => createKeyedTokenBucket({ capacity: 0, windowMs: 60_000 })).toThrow()
		expect(() => createKeyedTokenBucket({ capacity: 10, windowMs: 0 })).toThrow()
		const { bucket } = setup(10, 60_000)
		expect(() => bucket.take('ws-a', 0)).toThrow()
		expect(() => bucket.take('ws-a', 11)).toThrow()
	})
})
