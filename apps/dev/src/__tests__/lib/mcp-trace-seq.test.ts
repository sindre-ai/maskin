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
		// a and b aged out past the TTL and were swept when the cap was reached.
		expect(counter.size()).toBeLessThanOrEqual(3)
	})

	it('stays within the cap when every session is live', () => {
		const counter = createSeqCounter({ maxSessions: 2 })
		counter.next('a')
		counter.next('b')
		counter.next('c')
		expect(counter.size()).toBeLessThanOrEqual(2)
	})
})
