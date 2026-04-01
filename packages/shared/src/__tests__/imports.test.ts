import { describe, expect, it } from 'vitest'
import {
	columnMappingSchema,
	importFileTypeSchema,
	importMappingSchema,
	importParamsSchema,
	importQuerySchema,
	importStatusSchema,
	updateImportMappingSchema,
} from '../schemas/imports'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('importStatusSchema', () => {
	const statuses = ['uploading', 'mapping', 'importing', 'completed', 'failed']

	for (const status of statuses) {
		it(`accepts ${status}`, () => {
			expect(importStatusSchema.parse(status)).toBe(status)
		})
	}

	it('rejects unknown status', () => {
		expect(() => importStatusSchema.parse('cancelled')).toThrow()
	})
})

describe('importFileTypeSchema', () => {
	it('accepts csv', () => {
		expect(importFileTypeSchema.parse('csv')).toBe('csv')
	})

	it('accepts json', () => {
		expect(importFileTypeSchema.parse('json')).toBe('json')
	})

	it('rejects unknown file type', () => {
		expect(() => importFileTypeSchema.parse('xml')).toThrow()
	})
})

describe('columnMappingSchema', () => {
	it('accepts required fields with defaults', () => {
		const result = columnMappingSchema.parse({
			sourceColumn: 'Name',
			targetField: 'title',
		})
		expect(result.sourceColumn).toBe('Name')
		expect(result.targetField).toBe('title')
		expect(result.transform).toBe('none')
		expect(result.skip).toBe(false)
	})

	it('accepts all transform types', () => {
		for (const transform of ['none', 'date', 'number', 'boolean']) {
			const result = columnMappingSchema.parse({
				sourceColumn: 'col',
				targetField: 'field',
				transform,
			})
			expect(result.transform).toBe(transform)
		}
	})

	it('accepts skip as true', () => {
		const result = columnMappingSchema.parse({
			sourceColumn: 'col',
			targetField: 'field',
			skip: true,
		})
		expect(result.skip).toBe(true)
	})

	it('rejects invalid transform', () => {
		expect(() =>
			columnMappingSchema.parse({
				sourceColumn: 'col',
				targetField: 'field',
				transform: 'uppercase',
			}),
		).toThrow()
	})

	it('rejects missing sourceColumn', () => {
		expect(() => columnMappingSchema.parse({ targetField: 'title' })).toThrow()
	})

	it('rejects missing targetField', () => {
		expect(() => columnMappingSchema.parse({ sourceColumn: 'Name' })).toThrow()
	})
})

describe('importMappingSchema', () => {
	const validColumn = { sourceColumn: 'Name', targetField: 'title' }

	it('accepts a single type mapping', () => {
		const result = importMappingSchema.parse({
			typeMappings: [{ objectType: 'task', columns: [validColumn] }],
		})
		expect(result.typeMappings).toHaveLength(1)
		expect(result.typeMappings[0]?.objectType).toBe('task')
		expect(result.typeMappings[0]?.columns).toHaveLength(1)
		expect(result.relationships).toEqual([])
	})

	it('accepts multiple type mappings', () => {
		const result = importMappingSchema.parse({
			typeMappings: [
				{ objectType: 'task', columns: [validColumn] },
				{ objectType: 'insight', columns: [{ sourceColumn: 'Desc', targetField: 'content' }] },
			],
		})
		expect(result.typeMappings).toHaveLength(2)
	})

	it('accepts optional defaultStatus per type', () => {
		const result = importMappingSchema.parse({
			typeMappings: [{ objectType: 'task', columns: [validColumn], defaultStatus: 'todo' }],
		})
		expect(result.typeMappings[0]?.defaultStatus).toBe('todo')
	})

	it('accepts relationships with sourceType, relationshipType, targetType', () => {
		const result = importMappingSchema.parse({
			typeMappings: [
				{ objectType: 'task', columns: [validColumn] },
				{ objectType: 'insight', columns: [] },
			],
			relationships: [
				{ sourceType: 'task', relationshipType: 'relates_to', targetType: 'insight' },
			],
		})
		expect(result.relationships).toHaveLength(1)
		expect(result.relationships[0]).toEqual({
			sourceType: 'task',
			relationshipType: 'relates_to',
			targetType: 'insight',
		})
	})

	it('rejects empty typeMappings array', () => {
		expect(() => importMappingSchema.parse({ typeMappings: [] })).toThrow()
	})

	it('rejects missing typeMappings', () => {
		expect(() => importMappingSchema.parse({ relationships: [] })).toThrow()
	})
})

describe('updateImportMappingSchema', () => {
	it('accepts valid mapping', () => {
		const result = updateImportMappingSchema.parse({
			mapping: {
				typeMappings: [
					{ objectType: 'task', columns: [{ sourceColumn: 'Name', targetField: 'title' }] },
				],
			},
		})
		expect(result.mapping.typeMappings[0]?.objectType).toBe('task')
	})

	it('rejects missing mapping', () => {
		expect(() => updateImportMappingSchema.parse({})).toThrow()
	})
})

describe('importQuerySchema', () => {
	it('applies defaults', () => {
		const result = importQuerySchema.parse({})
		expect(result.status).toBeUndefined()
		expect(result.limit).toBe(20)
		expect(result.offset).toBe(0)
	})

	it('accepts valid status filter', () => {
		const result = importQuerySchema.parse({ status: 'completed' })
		expect(result.status).toBe('completed')
	})

	it('coerces string limit and offset', () => {
		const result = importQuerySchema.parse({ limit: '50', offset: '10' })
		expect(result.limit).toBe(50)
		expect(result.offset).toBe(10)
	})

	it('rejects limit below 1', () => {
		expect(() => importQuerySchema.parse({ limit: 0 })).toThrow()
	})

	it('rejects limit above 100', () => {
		expect(() => importQuerySchema.parse({ limit: 101 })).toThrow()
	})

	it('rejects negative offset', () => {
		expect(() => importQuerySchema.parse({ offset: -1 })).toThrow()
	})

	it('rejects invalid status', () => {
		expect(() => importQuerySchema.parse({ status: 'cancelled' })).toThrow()
	})
})

describe('importParamsSchema', () => {
	it('accepts valid uuid', () => {
		expect(importParamsSchema.parse({ id: uuid }).id).toBe(uuid)
	})

	it('rejects non-uuid', () => {
		expect(() => importParamsSchema.parse({ id: 'abc' })).toThrow()
	})

	it('rejects missing id', () => {
		expect(() => importParamsSchema.parse({})).toThrow()
	})
})
