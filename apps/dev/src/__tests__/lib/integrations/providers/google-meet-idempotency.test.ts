import { describe, expect, it } from 'vitest'
import {
	defaultEventRequestId,
	defaultIdempotencyKey,
	normalisePurpose,
} from '../../../../lib/integrations/providers/google-meet/idempotency'

describe('defaultIdempotencyKey', () => {
	const actorId = '11111111-1111-1111-1111-111111111111'
	const otherActor = '22222222-2222-2222-2222-222222222222'
	const day = new Date('2026-09-15T10:00:00.000Z')

	it('is stable for the same actor + purpose on the same day', () => {
		const a = defaultIdempotencyKey({ actorId, purpose: 'Sebk demo w/ Acme', now: day })
		const b = defaultIdempotencyKey({ actorId, purpose: 'Sebk demo w/ Acme', now: day })
		expect(a).toBe(b)
	})

	it('differs for different actors on the same day + same purpose', () => {
		const a = defaultIdempotencyKey({ actorId, purpose: 'Same purpose', now: day })
		const b = defaultIdempotencyKey({ actorId: otherActor, purpose: 'Same purpose', now: day })
		expect(a).not.toBe(b)
	})

	it('differs across UTC-day boundaries (a retry at 00:00:01 UTC gets a fresh key)', () => {
		const a = defaultIdempotencyKey({
			actorId,
			purpose: 'p',
			now: new Date('2026-09-15T23:59:59.000Z'),
		})
		const b = defaultIdempotencyKey({
			actorId,
			purpose: 'p',
			now: new Date('2026-09-16T00:00:01.000Z'),
		})
		expect(a).not.toBe(b)
	})

	it('collapses whitespace + casing variations to the same key (purpose normalisation)', () => {
		const a = defaultIdempotencyKey({ actorId, purpose: 'Sebk demo w/ Acme', now: day })
		const b = defaultIdempotencyKey({
			actorId,
			purpose: '  SEBK   demo w/ acme  ',
			now: day,
		})
		expect(a).toBe(b)
	})

	it('returns a 64-char hex sha256 digest', () => {
		const key = defaultIdempotencyKey({ actorId, purpose: 'p', now: day })
		expect(key).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe('normalisePurpose', () => {
	it('trims + lowercases + collapses whitespace', () => {
		expect(normalisePurpose('  Foo   BAR   baz\n')).toBe('foo bar baz')
	})
	it('leaves already-normalised strings alone', () => {
		expect(normalisePurpose('foo bar')).toBe('foo bar')
	})
})

describe('defaultEventRequestId', () => {
	const actorId = '11111111-1111-1111-1111-111111111111'

	it('is stable for the same actor + summary + start (GCal replay contract)', () => {
		const a = defaultEventRequestId({
			actorId,
			summary: 'Product review',
			startDateTime: '2026-09-15T15:00:00+02:00',
		})
		const b = defaultEventRequestId({
			actorId,
			summary: 'Product review',
			startDateTime: '2026-09-15T15:00:00+02:00',
		})
		expect(a).toBe(b)
	})

	it('differs when the start time changes (reschedule = new event = new space)', () => {
		const a = defaultEventRequestId({
			actorId,
			summary: 'Product review',
			startDateTime: '2026-09-15T15:00:00+02:00',
		})
		const b = defaultEventRequestId({
			actorId,
			summary: 'Product review',
			startDateTime: '2026-09-15T16:00:00+02:00',
		})
		expect(a).not.toBe(b)
	})

	it('differs when the summary changes', () => {
		const a = defaultEventRequestId({
			actorId,
			summary: 'Product review',
			startDateTime: '2026-09-15T15:00:00+02:00',
		})
		const b = defaultEventRequestId({
			actorId,
			summary: 'Product review 2',
			startDateTime: '2026-09-15T15:00:00+02:00',
		})
		expect(a).not.toBe(b)
	})
})
