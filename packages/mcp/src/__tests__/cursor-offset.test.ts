import { describe, expect, it } from 'vitest'
import { CURSOR_MAX_OFFSET, CURSOR_VERSION, decodeCursor, encodeCursor } from '../cursor'

const base = {
	s: '2026-10-12T10:00:00.000Z',
	o: 'desc' as const,
	k: { sortValue: '2026-10-12T09:00:00.000Z', id: '42' },
}

function rawCursor(payload: Record<string, unknown>) {
	return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...base, ...payload }), 'utf8').toString(
		'base64url',
	)
}

describe('cursor offset field n', () => {
	it('round-trips n through encodeCursor and decodeCursor', () => {
		const decoded = decodeCursor(encodeCursor({ ...base, n: 198 }))
		expect(decoded?.n).toBe(198)
		expect(decoded?.k).toEqual(base.k)
	})

	it('round-trips n = 0', () => {
		expect(decodeCursor(encodeCursor({ ...base, n: 0 }))?.n).toBe(0)
	})

	it('decodes a cursor without n with n absent', () => {
		const decoded = decodeCursor(encodeCursor(base))
		expect(decoded).not.toBeNull()
		expect(decoded).not.toHaveProperty('n')
	})

	it('keeps CURSOR_VERSION at 1', () => {
		expect(CURSOR_VERSION).toBe(1)
		expect(decodeCursor(encodeCursor({ ...base, n: 5 }))?.v).toBe(1)
	})

	it.each([
		['negative', -1],
		['fractional', 1.5],
		['a numeric string', '5'],
		['null', null],
		['non-finite', 'Infinity'],
		['above the cap', CURSOR_MAX_OFFSET + 1],
	])('returns null when n is %s', (_label, n) => {
		expect(decodeCursor(rawCursor({ n }))).toBeNull()
	})

	it('accepts n at the cap', () => {
		expect(decodeCursor(rawCursor({ n: CURSOR_MAX_OFFSET }))?.n).toBe(CURSOR_MAX_OFFSET)
	})
})
