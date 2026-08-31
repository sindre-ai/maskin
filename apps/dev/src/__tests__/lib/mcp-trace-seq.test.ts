import { describe, expect, it } from 'vitest'
import { createSeqCounter } from '../../lib/mcp-trace-seq'

describe('createSeqCounter', () => {
	it('numbers calls from 1 and increments per session', () => {
		const counter = createSeqCounter()
		expect(counter.next('s1')).toBe(1)
		expect(counter.next('s1')).toBe(2)
		expect(counter.next('s1')).toBe(3)
	})

	it('keeps sequences independent across sessions', () => {
		const counter = createSeqCounter()
		expect(counter.next('a')).toBe(1)
		expect(counter.next('b')).toBe(1)
		expect(counter.next('a')).toBe(2)
		expect(counter.next('b')).toBe(2)
	})

	it('restarts numbering for a session id reused after the TTL', () => {
		let now = 1_000
		const counter = createSeqCounter({ ttlMs: 100, now: () => now })
		expect(counter.next('s1')).toBe(1)
		expect(counter.next('s1')).toBe(2)
		now += 500
		expect(counter.next('s1')).toBe(1)
	})

	it('evicts stale sessions instead of growing without bound', () => {
		let now = 1_000
		const counter = createSeqCounter({ ttlMs: 100, maxSessions: 3, now: () => now })
		counter.next('a')
		counter.next('b')
		now += 500
		counter.next('c')
		counter.next('d')
		// a and b aged out past the TTL and were swept when the cap was reached,
		// leaving exactly c and d. Asserting the exact size matters: a
		// `<= maxSessions` bound also passes for an implementation that skips the
		// TTL sweep and blindly evicts live entries.
		expect(counter.size()).toBe(2)
	})

	// Regression: eviction used to run BEFORE the existing-session lookup, so at
	// the cap every call evicted a peer, each session then found itself missing,
	// and every seq collapsed to 1 — ordering silently destroyed at a threshold
	// rather than degrading. Assert counter VALUES; size() cannot see this.
	it('keeps numbering live sessions correctly when the cap is saturated', () => {
		const counter = createSeqCounter({ maxSessions: 2 })
		expect(counter.next('a')).toBe(1)
		expect(counter.next('b')).toBe(1)
		// Both are live and already tracked, so neither should evict the other
		// no matter how many times they alternate.
		expect(counter.next('a')).toBe(2)
		expect(counter.next('b')).toBe(2)
		expect(counter.next('a')).toBe(3)
		expect(counter.next('b')).toBe(3)
		expect(counter.size()).toBe(2)
	})

	it('evicts the oldest session to admit a genuinely new one', () => {
		const counter = createSeqCounter({ maxSessions: 2 })
		counter.next('a')
		counter.next('b')
		counter.next('c') // admitting c evicts a, the oldest
		expect(counter.size()).toBe(2)
		// b and c survived and keep counting; a was evicted and restarts.
		expect(counter.next('b')).toBe(2)
		expect(counter.next('c')).toBe(2)
	})
})
