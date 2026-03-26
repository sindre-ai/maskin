import { describe, expect, it } from 'vitest'
import { safeJsonValue, safeMetadataSchema } from '../schemas/primitives'

describe('safeJsonValue', () => {
	it('accepts a string', () => {
		expect(safeJsonValue.parse('hello')).toBe('hello')
	})

	it('accepts a number', () => {
		expect(safeJsonValue.parse(42)).toBe(42)
	})

	it('accepts a boolean', () => {
		expect(safeJsonValue.parse(true)).toBe(true)
	})

	it('accepts null', () => {
		expect(safeJsonValue.parse(null)).toBeNull()
	})

	it('accepts an array of primitives', () => {
		expect(safeJsonValue.parse(['a', 1, true, null])).toEqual(['a', 1, true, null])
	})

	it('rejects undefined', () => {
		expect(() => safeJsonValue.parse(undefined)).toThrow()
	})

	it('rejects a plain object', () => {
		expect(() => safeJsonValue.parse({ key: 'value' })).toThrow()
	})

	it('rejects an array containing objects', () => {
		expect(() => safeJsonValue.parse([{ nested: true }])).toThrow()
	})
})

describe('safeMetadataSchema', () => {
	it('accepts a record of primitives', () => {
		const data = { key: 'value', count: 42, active: true, empty: null }
		expect(safeMetadataSchema.parse(data)).toEqual(data)
	})

	it('accepts a record with array values', () => {
		const data = { tags: ['a', 'b'] }
		expect(safeMetadataSchema.parse(data)).toEqual(data)
	})

	it('accepts an empty object', () => {
		expect(safeMetadataSchema.parse({})).toEqual({})
	})

	it('rejects nested objects as values', () => {
		expect(() => safeMetadataSchema.parse({ nested: { deep: true } })).toThrow()
	})
})
