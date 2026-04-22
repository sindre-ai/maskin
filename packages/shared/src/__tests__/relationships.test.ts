import { describe, expect, it } from 'vitest'
import {
	createRelationshipSchema,
	relationshipParamsSchema,
	relationshipQuerySchema,
} from '../schemas/relationships'

const uuid = '550e8400-e29b-41d4-a716-446655440000'
const uuid2 = '660e8400-e29b-41d4-a716-446655440000'

describe('createRelationshipSchema', () => {
	it('accepts valid input', () => {
		const result = createRelationshipSchema.parse({
			source_type: 'insight',
			source_id: uuid,
			target_type: 'bet',
			target_id: uuid2,
			type: 'informs',
		})
		expect(result.source_type).toBe('insight')
		expect(result.type).toBe('informs')
	})

	it('rejects missing source_id', () => {
		expect(() =>
			createRelationshipSchema.parse({
				source_type: 'insight',
				target_type: 'bet',
				target_id: uuid2,
				type: 'informs',
			}),
		).toThrow()
	})

	it('rejects invalid uuid for source_id', () => {
		expect(() =>
			createRelationshipSchema.parse({
				source_type: 'insight',
				source_id: 'not-uuid',
				target_type: 'bet',
				target_id: uuid2,
				type: 'informs',
			}),
		).toThrow()
	})

	it('rejects missing type', () => {
		expect(() =>
			createRelationshipSchema.parse({
				source_type: 'insight',
				source_id: uuid,
				target_type: 'bet',
				target_id: uuid2,
			}),
		).toThrow()
	})

	it('accepts assigned_to edge from object to actor', () => {
		const result = createRelationshipSchema.parse({
			source_type: 'object',
			source_id: uuid,
			target_type: 'actor',
			target_id: uuid2,
			type: 'assigned_to',
		})
		expect(result.type).toBe('assigned_to')
	})

	it('accepts watches edge from object to actor', () => {
		const result = createRelationshipSchema.parse({
			source_type: 'object',
			source_id: uuid,
			target_type: 'actor',
			target_id: uuid2,
			type: 'watches',
		})
		expect(result.type).toBe('watches')
	})

	it('rejects assigned_to edge with wrong target_type', () => {
		expect(() =>
			createRelationshipSchema.parse({
				source_type: 'object',
				source_id: uuid,
				target_type: 'object',
				target_id: uuid2,
				type: 'assigned_to',
			}),
		).toThrow()
	})

	it('rejects watches edge with wrong source_type', () => {
		expect(() =>
			createRelationshipSchema.parse({
				source_type: 'actor',
				source_id: uuid,
				target_type: 'actor',
				target_id: uuid2,
				type: 'watches',
			}),
		).toThrow()
	})
})

describe('relationshipQuerySchema', () => {
	it('provides default limit and offset', () => {
		const result = relationshipQuerySchema.parse({})
		expect(result.limit).toBe(50)
		expect(result.offset).toBe(0)
	})

	it('accepts optional filters', () => {
		const result = relationshipQuerySchema.parse({
			source_id: uuid,
			target_id: uuid2,
			type: 'informs',
		})
		expect(result.source_id).toBe(uuid)
		expect(result.type).toBe('informs')
	})

	it('coerces string numbers', () => {
		const result = relationshipQuerySchema.parse({ limit: '10', offset: '5' })
		expect(result.limit).toBe(10)
		expect(result.offset).toBe(5)
	})
})

describe('relationshipParamsSchema', () => {
	it('accepts valid uuid', () => {
		expect(relationshipParamsSchema.parse({ id: uuid }).id).toBe(uuid)
	})

	it('rejects non-uuid', () => {
		expect(() => relationshipParamsSchema.parse({ id: 'abc' })).toThrow()
	})
})
