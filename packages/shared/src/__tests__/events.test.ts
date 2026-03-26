import { describe, expect, it } from 'vitest'
import { createCommentSchema, eventQuerySchema } from '../schemas/events'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('eventQuerySchema', () => {
	it('provides default limit and offset', () => {
		const result = eventQuerySchema.parse({})
		expect(result.limit).toBe(50)
		expect(result.offset).toBe(0)
	})

	it('accepts all optional filters', () => {
		const result = eventQuerySchema.parse({
			entity_type: 'task',
			entity_id: uuid,
			action: 'created',
			since: 1000,
		})
		expect(result.entity_type).toBe('task')
		expect(result.since).toBe(1000)
	})

	it('coerces since from string', () => {
		const result = eventQuerySchema.parse({ since: '500' })
		expect(result.since).toBe(500)
	})

	it('coerces limit and offset from strings', () => {
		const result = eventQuerySchema.parse({ limit: '25', offset: '10' })
		expect(result.limit).toBe(25)
		expect(result.offset).toBe(10)
	})
})

describe('createCommentSchema', () => {
	it('accepts valid comment', () => {
		const result = createCommentSchema.parse({
			entity_id: uuid,
			content: 'This is a comment',
		})
		expect(result.entity_id).toBe(uuid)
		expect(result.content).toBe('This is a comment')
	})

	it('rejects missing entity_id', () => {
		expect(() => createCommentSchema.parse({ content: 'test' })).toThrow()
	})

	it('rejects missing content', () => {
		expect(() => createCommentSchema.parse({ entity_id: uuid })).toThrow()
	})

	it('rejects empty content', () => {
		expect(() => createCommentSchema.parse({ entity_id: uuid, content: '' })).toThrow()
	})

	it('rejects content exceeding 10000 chars', () => {
		expect(() =>
			createCommentSchema.parse({ entity_id: uuid, content: 'x'.repeat(10001) }),
		).toThrow()
	})

	it('accepts content at max 10000 chars', () => {
		const result = createCommentSchema.parse({ entity_id: uuid, content: 'x'.repeat(10000) })
		expect(result.content).toHaveLength(10000)
	})

	it('accepts optional mentions array', () => {
		const result = createCommentSchema.parse({
			entity_id: uuid,
			content: 'hey',
			mentions: [uuid],
		})
		expect(result.mentions).toEqual([uuid])
	})

	it('rejects mentions exceeding 50', () => {
		const mentions = Array.from({ length: 51 }, () => uuid)
		expect(() => createCommentSchema.parse({ entity_id: uuid, content: 'hey', mentions })).toThrow()
	})

	it('accepts optional parent_event_id as positive integer', () => {
		const result = createCommentSchema.parse({
			entity_id: uuid,
			content: 'reply',
			parent_event_id: 42,
		})
		expect(result.parent_event_id).toBe(42)
	})

	it('rejects non-positive parent_event_id', () => {
		expect(() =>
			createCommentSchema.parse({ entity_id: uuid, content: 'reply', parent_event_id: 0 }),
		).toThrow()
	})
})
