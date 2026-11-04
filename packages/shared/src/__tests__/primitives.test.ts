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

	it('accepts a shallow map of string arrays (closed_statuses shape)', () => {
		const data = { content: ['live'], task: ['done', 'validated'] }
		expect(safeJsonValue.parse(data)).toEqual(data)
	})

	it('accepts an empty map (allows resetting closed_statuses to {})', () => {
		expect(safeJsonValue.parse({})).toEqual({})
	})

	it('rejects a map whose values are not string arrays', () => {
		expect(() => safeJsonValue.parse({ content: 'live' })).toThrow()
		expect(() => safeJsonValue.parse({ content: [1, 2] })).toThrow()
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

	it("accepts a loop's closed_statuses map (shallow record of string arrays)", () => {
		const data = { closed_statuses: { content: ['live'], task: ['done'] } }
		expect(safeMetadataSchema.parse(data)).toEqual(data)
	})

	it('still rejects a two-level nested map inside closed_statuses', () => {
		expect(() =>
			safeMetadataSchema.parse({ closed_statuses: { content: { live: true } } }),
		).toThrow()
	})
})

describe('safeMetadataSchema: loop targets', () => {
	const row = { label: 'Funds engaged', source: 'manual', actual: 0, target: 4 }

	it('accepts a list of valid target rows', () => {
		const data = {
			targets: [
				row,
				{ ...row, label: 'Replies', ownerActorId: crypto.randomUUID(), pace_policy: 'strict' },
			],
		}
		expect(safeMetadataSchema.parse(data)).toEqual(data)
	})

	it('still accepts an empty list and null to clear the targets', () => {
		expect(safeMetadataSchema.parse({ targets: [] })).toEqual({ targets: [] })
		expect(safeMetadataSchema.parse({ targets: null })).toEqual({ targets: null })
	})

	it('rejects a row with no label and names the row', () => {
		const { label: _label, ...noLabel } = row
		const result = safeMetadataSchema.safeParse({ targets: [row, noLabel] })
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['targets', 1, 'label'])
			expect(result.error.issues[0]?.message).toContain('targets row 2')
		}
	})

	it('rejects a row whose actual or target is not a number', () => {
		expect(safeMetadataSchema.safeParse({ targets: [{ ...row, actual: '3' }] }).success).toBe(false)
		expect(safeMetadataSchema.safeParse({ targets: [{ ...row, target: 'four' }] }).success).toBe(
			false,
		)
	})

	it('rejects a string for targets', () => {
		expect(safeMetadataSchema.safeParse({ targets: 'Funds engaged: 4' }).success).toBe(false)
	})

	it('rejects a list of plain strings for targets', () => {
		expect(safeMetadataSchema.safeParse({ targets: ['Funds engaged'] }).success).toBe(false)
	})

	it('does not allow a list of objects under any other key', () => {
		expect(safeMetadataSchema.safeParse({ rows: [row] }).success).toBe(false)
	})

	it('keeps closed_statuses working next to targets', () => {
		const data = { closed_statuses: { task: ['done'] }, targets: [row] }
		expect(safeMetadataSchema.parse(data)).toEqual(data)
	})
})
