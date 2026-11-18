import { describe, expect, it } from 'vitest'
import { BodyEditError, editBody } from '../../lib/object-update'

describe('editBody', () => {
	it('returns undefined when the update has neither append nor replace', () => {
		expect(editBody('stored', {})).toBeUndefined()
		expect(editBody('stored', { content: 'whole body' })).toBeUndefined()
	})

	it('appends to the end of the stored body exactly as sent', () => {
		expect(editBody('one\ntwo', { append: '\nthree' })).toBe('one\ntwo\nthree')
	})

	it('appends to an object with no body yet', () => {
		expect(editBody(null, { append: 'first line' })).toBe('first line')
	})

	it('replaces one match and leaves the rest of the body untouched', () => {
		const stored = `${'x'.repeat(5000)}Status: draft${'y'.repeat(5000)}`
		const next = editBody(stored, { replace: { find: 'Status: draft', with: 'Status: approved' } })
		expect(next).toBe(`${'x'.repeat(5000)}Status: approved${'y'.repeat(5000)}`)
	})

	it('takes the replacement as plain text, not as a pattern', () => {
		expect(editBody('price: X', { replace: { find: 'X', with: "$& $1 $'" } })).toBe(
			"price: $& $1 $'",
		)
	})

	it('removes the piece when the replacement is empty', () => {
		expect(editBody('keep drop keep', { replace: { find: ' drop', with: '' } })).toBe('keep keep')
	})

	it('refuses a piece that is not in the body and says so', () => {
		expect(() => editBody('abc', { replace: { find: 'zzz', with: 'q' } })).toThrow(
			/not found.*Nothing was written/,
		)
		expect(() => editBody(null, { replace: { find: 'zzz', with: 'q' } })).toThrow(BodyEditError)
	})

	it('refuses a piece that matches more than once and says how many', () => {
		expect(() => editBody('a b a b a', { replace: { find: 'a', with: 'q' } })).toThrow(
			/found 3 times.*Nothing was written/,
		)
	})

	it('replaces every match when all is true', () => {
		expect(editBody('a b a', { replace: { find: 'a', with: 'q', all: true } })).toBe('q b q')
	})

	it('refuses content together with append or replace', () => {
		expect(() => editBody('abc', { content: 'new', append: 'x' })).toThrow(/not both/)
		expect(() => editBody('abc', { content: 'new', replace: { find: 'a', with: 'b' } })).toThrow(
			/not both/,
		)
	})

	it('refuses append together with replace', () => {
		expect(() => editBody('abc', { append: 'x', replace: { find: 'a', with: 'b' } })).toThrow(
			/not both/,
		)
	})
})
