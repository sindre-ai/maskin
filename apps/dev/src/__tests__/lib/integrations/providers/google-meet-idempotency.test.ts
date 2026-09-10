import { describe, expect, it } from 'vitest'
import {
	defaultCalendarRequestId,
	defaultSpaceIdempotencyKey,
	normalisePurpose,
	utcDate,
} from '../../../../lib/integrations/providers/google-meet/idempotency'

describe('normalisePurpose', () => {
	it('collapses whitespace and lowercases', () => {
		expect(normalisePurpose('  Sebk  Demo   w/ Acme  ')).toBe('sebk demo w/ acme')
	})
})

describe('utcDate', () => {
	it('returns YYYY-MM-DD in UTC regardless of input tz', () => {
		expect(utcDate(new Date('2026-09-10T23:59:00Z'))).toBe('2026-09-10')
		expect(utcDate(new Date('2026-09-11T00:00:01Z'))).toBe('2026-09-11')
	})
})

describe('defaultSpaceIdempotencyKey', () => {
	it('collapses to the same key for two calls with the same actor + purpose within the UTC day', () => {
		const now = new Date('2026-09-10T09:00:00Z')
		const later = new Date('2026-09-10T22:00:00Z')
		const k1 = defaultSpaceIdempotencyKey('actor-1', '  Sebk demo w/ Acme  ', now)
		const k2 = defaultSpaceIdempotencyKey('actor-1', 'sebk DEMO w/ Acme', later)
		expect(k1).toBe(k2)
	})

	it('produces a different key across days', () => {
		const day1 = defaultSpaceIdempotencyKey(
			'actor-1',
			'Sebk demo',
			new Date('2026-09-10T09:00:00Z'),
		)
		const day2 = defaultSpaceIdempotencyKey(
			'actor-1',
			'Sebk demo',
			new Date('2026-09-11T09:00:00Z'),
		)
		expect(day1).not.toBe(day2)
	})

	it('produces a different key per actor', () => {
		const a = defaultSpaceIdempotencyKey('actor-A', 'Same purpose', new Date('2026-09-10T09:00:00Z'))
		const b = defaultSpaceIdempotencyKey('actor-B', 'Same purpose', new Date('2026-09-10T09:00:00Z'))
		expect(a).not.toBe(b)
	})

	it('is a 64-char sha256 hex digest', () => {
		const k = defaultSpaceIdempotencyKey('actor-1', 'x', new Date('2026-09-10T09:00:00Z'))
		expect(k).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe('defaultCalendarRequestId', () => {
	it('is deterministic across identical inputs — Google-side replay-safe', () => {
		const a = defaultCalendarRequestId('actor-1', 'Acme × Beta demo', '2026-09-11T15:00:00-07:00')
		const b = defaultCalendarRequestId('actor-1', 'Acme × Beta demo', '2026-09-11T15:00:00-07:00')
		expect(a).toBe(b)
	})

	it('differs when start.date_time differs', () => {
		const early = defaultCalendarRequestId('actor-1', 'demo', '2026-09-11T15:00:00-07:00')
		const late = defaultCalendarRequestId('actor-1', 'demo', '2026-09-11T16:00:00-07:00')
		expect(early).not.toBe(late)
	})
})
