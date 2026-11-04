import { describe, expect, it } from 'vitest'
import {
	USER_CODE_ALPHABET,
	USER_CODE_LENGTH,
	formatUserCode,
	normalizeUserCode,
} from '../schemas/device-auth'

describe('normalizeUserCode', () => {
	it('ignores case, dashes and spaces', () => {
		expect(normalizeUserCode('bcdf-2345')).toBe('BCDF2345')
		expect(normalizeUserCode(' BCDF 2345 ')).toBe('BCDF2345')
		expect(normalizeUserCode('bcdf2345')).toBe('BCDF2345')
	})

	it('rejects the wrong length', () => {
		expect(normalizeUserCode('BCDF234')).toBeNull()
		expect(normalizeUserCode('BCDF23456')).toBeNull()
		expect(normalizeUserCode('')).toBeNull()
	})

	it('rejects characters outside the alphabet (vowels, 0, 1)', () => {
		expect(normalizeUserCode('ABCD2345')).toBeNull()
		expect(normalizeUserCode('BCDF0345')).toBeNull()
		expect(normalizeUserCode('BCDF1345')).toBeNull()
	})
})

describe('formatUserCode', () => {
	it('puts a dash in the middle and round-trips through normalize', () => {
		expect(formatUserCode('BCDF2345')).toBe('BCDF-2345')
		expect(normalizeUserCode(formatUserCode('BCDF2345'))).toBe('BCDF2345')
	})
})

describe('user-code alphabet', () => {
	it('has no vowels or look-alikes, and no duplicates', () => {
		expect(USER_CODE_ALPHABET).not.toMatch(/[AEIOULY01]/)
		expect(new Set(USER_CODE_ALPHABET).size).toBe(USER_CODE_ALPHABET.length)
		expect(USER_CODE_LENGTH).toBe(8)
	})
})
