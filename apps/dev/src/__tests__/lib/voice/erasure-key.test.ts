import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { erasureMarkerFor, normalizeDanishNumber } from '../../../lib/outreach/voice/dnc-gate'
import {
	ERASURE_MARKER_PREFIX,
	MIN_ERASURE_KEY_BYTES,
	computeErasureMarker,
	parseErasureKey,
} from '../../../lib/outreach/voice/erasure-key'

const KEY = 'test-erasure-marker-key-0123456789-abcdef'

function key() {
	const parsed = parseErasureKey(KEY)
	if (!parsed.ok) throw new Error('test key must parse')
	return parsed.key
}

describe('parseErasureKey', () => {
	it('accepts a key of 32 bytes or more', () => {
		expect(parseErasureKey('k'.repeat(MIN_ERASURE_KEY_BYTES))).toMatchObject({ ok: true })
		expect(parseErasureKey(KEY)).toMatchObject({ ok: true })
	})

	it('counts bytes, not characters', () => {
		// 16 two-byte characters is 32 bytes.
		expect(parseErasureKey('é'.repeat(16))).toMatchObject({ ok: true })
		expect(parseErasureKey('é'.repeat(15))).toMatchObject({ ok: false })
	})

	it.each([undefined, '', '   '])('reports %j as not set', (raw) => {
		expect(parseErasureKey(raw)).toEqual({
			ok: false,
			reason: 'VOICE_ERASURE_MARKER_KEY is not set',
		})
	})

	it('reports a key under 32 bytes as too short, without echoing it', () => {
		const short = 'k'.repeat(MIN_ERASURE_KEY_BYTES - 1)
		const parsed = parseErasureKey(short)
		expect(parsed).toMatchObject({ ok: false })
		expect(parsed.ok === false && parsed.reason).toContain('shorter than 32 bytes')
		expect(JSON.stringify(parsed)).not.toContain(short)
	})
})

describe('computeErasureMarker', () => {
	it('is v1: plus the hex HMAC-SHA-256 of the number', () => {
		const expected = createHmac('sha256', KEY).update('+4520123456').digest('hex')
		expect(computeErasureMarker('+4520123456', key())).toBe(`${ERASURE_MARKER_PREFIX}${expected}`)
		expect(computeErasureMarker('+4520123456', key())).toMatch(/^v1:[0-9a-f]{64}$/)
	})

	it('differs per number and per key, and is not a plain SHA-256', () => {
		const other = parseErasureKey(`${KEY}-other`)
		if (!other.ok) throw new Error('other key must parse')
		expect(computeErasureMarker('+4520123456', key())).not.toBe(
			computeErasureMarker('+4520123457', key()),
		)
		expect(computeErasureMarker('+4520123456', key())).not.toBe(
			computeErasureMarker('+4520123456', other.key),
		)
	})
})

describe('erasureMarkerFor', () => {
	it.each(['+4512345678', '+45 12 34 56 78', '0045 12345678', '0045-12-34-56-78', '12345678'])(
		'gives the same marker for %s as for +4512345678',
		(raw) => {
			expect(erasureMarkerFor(raw, key())).toBe(computeErasureMarker('+4512345678', key()))
		},
	)

	it('uses the dialer normaliser, so what the dialer would call is what is hashed', () => {
		const raw = '(+45) 12.34.56.78'
		const e164 = normalizeDanishNumber(raw)
		expect(e164).toBe('+4512345678')
		expect(erasureMarkerFor(raw, key())).toBe(computeErasureMarker(e164 ?? '', key()))
	})

	it.each([null, undefined, 42, '', '+4612345678', '1234567'])('gives no marker for %j', (raw) => {
		expect(erasureMarkerFor(raw, key())).toBeNull()
	})
})
