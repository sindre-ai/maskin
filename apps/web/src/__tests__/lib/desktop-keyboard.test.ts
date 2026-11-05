import { KEYBOARD_SENTINEL, SPECIAL_KEYS, diffTyped, keysymForChar } from '@/lib/desktop-keyboard'
import { describe, expect, it } from 'vitest'

describe('keysymForChar', () => {
	it('uses the character code for Latin-1', () => {
		expect(keysymForChar('a')).toBe(0x61)
		expect(keysymForChar('Å')).toBe(0xc5)
	})

	it('prefixes characters beyond Latin-1 with the Unicode plane', () => {
		expect(keysymForChar('€')).toBe(0x01000000 + 0x20ac)
		expect(keysymForChar('😀')).toBe(0x01000000 + 0x1f600)
	})

	it('turns a line break into Return', () => {
		expect(keysymForChar('\n')).toBe(SPECIAL_KEYS.Enter)
	})
})

describe('diffTyped', () => {
	it('reports added characters', () => {
		expect(diffTyped(KEYBOARD_SENTINEL, `${KEYBOARD_SENTINEL}hi`)).toEqual({
			backspaces: 0,
			typed: ['h', 'i'],
		})
	})

	it('reports a deleted character as one Backspace', () => {
		expect(diffTyped(KEYBOARD_SENTINEL, KEYBOARD_SENTINEL.slice(1))).toEqual({
			backspaces: 1,
			typed: [],
		})
	})

	it('reports an autocorrect as Backspaces then the new letters', () => {
		expect(diffTyped(`${KEYBOARD_SENTINEL}teh`, `${KEYBOARD_SENTINEL}the`)).toEqual({
			backspaces: 2,
			typed: ['h', 'e'],
		})
	})

	it('keeps an emoji in one piece', () => {
		expect(diffTyped('', '😀').typed).toEqual(['😀'])
	})

	it('reports nothing when nothing changed', () => {
		expect(diffTyped('abc', 'abc')).toEqual({ backspaces: 0, typed: [] })
	})
})
