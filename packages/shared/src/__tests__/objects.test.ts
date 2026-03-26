import { describe, expect, it } from 'vitest'
import {
	createObjectSchema,
	objectParamsSchema,
	objectQuerySchema,
	objectTypeSchema,
	searchObjectsSchema,
	updateObjectSchema,
} from '../schemas/objects'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('objectTypeSchema', () => {
	it('accepts any non-empty string type', () => {
		expect(objectTypeSchema.parse('insight')).toBe('insight')
		expect(objectTypeSchema.parse('bet')).toBe('bet')
		expect(objectTypeSchema.parse('task')).toBe('task')
		expect(objectTypeSchema.parse('meeting')).toBe('meeting')
		expect(objectTypeSchema.parse('contact')).toBe('contact')
	})

	it('rejects empty string', () => {
		expect(() => objectTypeSchema.parse('')).toThrow()
	})
})

describe('createObjectSchema', () => {
	it('accepts valid input with required fields', () => {
		const result = createObjectSchema.parse({ type: 'task', status: 'todo' })
		expect(result.type).toBe('task')
		expect(result.status).toBe('todo')
	})

	it('accepts all optional fields', () => {
		const result = createObjectSchema.parse({
			id: uuid,
			type: 'bet',
			title: 'My bet',
			content: 'Details',
			status: 'active',
			metadata: { priority: 'high' },
			owner: uuid,
		})
		expect(result.id).toBe(uuid)
		expect(result.title).toBe('My bet')
		expect(result.metadata).toEqual({ priority: 'high' })
	})

	it('rejects missing type', () => {
		expect(() => createObjectSchema.parse({ status: 'todo' })).toThrow()
	})

	it('rejects missing status', () => {
		expect(() => createObjectSchema.parse({ type: 'task' })).toThrow()
	})

	it('rejects invalid uuid for id', () => {
		expect(() =>
			createObjectSchema.parse({ type: 'task', status: 'todo', id: 'not-uuid' }),
		).toThrow()
	})

	it('rejects invalid uuid for owner', () => {
		expect(() =>
			createObjectSchema.parse({ type: 'task', status: 'todo', owner: 'not-uuid' }),
		).toThrow()
	})
})

describe('updateObjectSchema', () => {
	it('accepts empty object', () => {
		const result = updateObjectSchema.parse({})
		expect(result).toEqual({})
	})

	it('accepts partial fields', () => {
		const result = updateObjectSchema.parse({ title: 'Updated' })
		expect(result.title).toBe('Updated')
	})

	it('accepts null owner to clear assignment', () => {
		const result = updateObjectSchema.parse({ owner: null })
		expect(result.owner).toBeNull()
	})

	it('accepts uuid owner', () => {
		const result = updateObjectSchema.parse({ owner: uuid })
		expect(result.owner).toBe(uuid)
	})
})

describe('objectQuerySchema', () => {
	it('provides default limit and offset', () => {
		const result = objectQuerySchema.parse({})
		expect(result.limit).toBe(50)
		expect(result.offset).toBe(0)
	})

	it('coerces string numbers', () => {
		const result = objectQuerySchema.parse({ limit: '25', offset: '10' })
		expect(result.limit).toBe(25)
		expect(result.offset).toBe(10)
	})

	it('rejects limit above 100', () => {
		expect(() => objectQuerySchema.parse({ limit: 101 })).toThrow()
	})

	it('rejects limit below 1', () => {
		expect(() => objectQuerySchema.parse({ limit: 0 })).toThrow()
	})

	it('rejects negative offset', () => {
		expect(() => objectQuerySchema.parse({ offset: -1 })).toThrow()
	})

	it('accepts optional type filter', () => {
		const result = objectQuerySchema.parse({ type: 'bet' })
		expect(result.type).toBe('bet')
	})

	it('accepts optional owner filter', () => {
		const result = objectQuerySchema.parse({ owner: uuid })
		expect(result.owner).toBe(uuid)
	})
})

describe('searchObjectsSchema', () => {
	it('requires q with min 1 char', () => {
		const result = searchObjectsSchema.parse({ q: 'test' })
		expect(result.q).toBe('test')
	})

	it('rejects empty q', () => {
		expect(() => searchObjectsSchema.parse({ q: '' })).toThrow()
	})

	it('rejects missing q', () => {
		expect(() => searchObjectsSchema.parse({})).toThrow()
	})

	it('defaults limit to 20', () => {
		const result = searchObjectsSchema.parse({ q: 'test' })
		expect(result.limit).toBe(20)
	})

	it('defaults offset to 0', () => {
		const result = searchObjectsSchema.parse({ q: 'test' })
		expect(result.offset).toBe(0)
	})
})

describe('objectParamsSchema', () => {
	it('accepts valid uuid', () => {
		const result = objectParamsSchema.parse({ id: uuid })
		expect(result.id).toBe(uuid)
	})

	it('rejects non-uuid string', () => {
		expect(() => objectParamsSchema.parse({ id: 'abc' })).toThrow()
	})

	it('rejects missing id', () => {
		expect(() => objectParamsSchema.parse({})).toThrow()
	})
})
