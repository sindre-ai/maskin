import { describe, expect, it } from 'vitest'
import {
	eventDefinitionSchema,
	integrationParamsSchema,
	providerInfoSchema,
	providerParamsSchema,
} from '../schemas/integrations'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('eventDefinitionSchema', () => {
	it('accepts valid event definition', () => {
		const result = eventDefinitionSchema.parse({
			entityType: 'issue',
			actions: ['opened', 'closed'],
			label: 'Issue events',
		})
		expect(result.entityType).toBe('issue')
		expect(result.actions).toEqual(['opened', 'closed'])
	})

	it('rejects missing entityType', () => {
		expect(() => eventDefinitionSchema.parse({ actions: ['opened'], label: 'test' })).toThrow()
	})

	it('rejects missing actions', () => {
		expect(() => eventDefinitionSchema.parse({ entityType: 'issue', label: 'test' })).toThrow()
	})

	it('rejects missing label', () => {
		expect(() =>
			eventDefinitionSchema.parse({ entityType: 'issue', actions: ['opened'] }),
		).toThrow()
	})
})

describe('providerInfoSchema', () => {
	it('accepts valid provider info', () => {
		const result = providerInfoSchema.parse({
			name: 'github',
			displayName: 'GitHub',
			events: [{ entityType: 'issue', actions: ['opened'], label: 'Issues' }],
		})
		expect(result.name).toBe('github')
		expect(result.events).toHaveLength(1)
	})

	it('rejects missing name', () => {
		expect(() => providerInfoSchema.parse({ displayName: 'X', events: [] })).toThrow()
	})
})

describe('providerParamsSchema', () => {
	it('accepts non-empty provider string', () => {
		expect(providerParamsSchema.parse({ provider: 'github' }).provider).toBe('github')
	})

	it('rejects empty provider string', () => {
		expect(() => providerParamsSchema.parse({ provider: '' })).toThrow()
	})
})

describe('integrationParamsSchema', () => {
	it('accepts valid uuid', () => {
		expect(integrationParamsSchema.parse({ id: uuid }).id).toBe(uuid)
	})

	it('rejects non-uuid', () => {
		expect(() => integrationParamsSchema.parse({ id: 'abc' })).toThrow()
	})
})
