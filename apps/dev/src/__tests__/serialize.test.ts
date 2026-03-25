import { describe, expect, it } from 'vitest'
import { serialize, serializeArray } from '../lib/serialize'

describe('serialize', () => {
	it('converts Date fields to ISO strings', () => {
		const date = new Date('2025-01-01T00:00:00Z')
		const result = serialize({
			id: '123',
			name: 'test',
			createdAt: date,
			updatedAt: date,
		})
		expect(result.createdAt).toBe('2025-01-01T00:00:00.000Z')
		expect(result.updatedAt).toBe('2025-01-01T00:00:00.000Z')
		expect(result.id).toBe('123')
		expect(result.name).toBe('test')
	})

	it('handles null dates', () => {
		const result = serialize({
			id: '123',
			createdAt: null,
		})
		expect(result.createdAt).toBeNull()
	})

	it('preserves non-date fields', () => {
		const result = serialize({
			count: 42,
			active: true,
			tags: ['a', 'b'],
			metadata: { key: 'value' },
		})
		expect(result.count).toBe(42)
		expect(result.active).toBe(true)
		expect(result.tags).toEqual(['a', 'b'])
		expect(result.metadata).toEqual({ key: 'value' })
	})
})

describe('serializeArray', () => {
	it('serializes all records in array', () => {
		const date = new Date('2025-06-15T12:00:00Z')
		const results = serializeArray([
			{ id: '1', createdAt: date },
			{ id: '2', createdAt: null },
		])
		expect(results).toHaveLength(2)
		expect(results[0]?.createdAt).toBe('2025-06-15T12:00:00.000Z')
		expect(results[1]?.createdAt).toBeNull()
	})
})
