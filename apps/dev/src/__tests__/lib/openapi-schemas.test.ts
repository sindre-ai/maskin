import { describe, expect, it } from 'vitest'
import { jsonbField, workspaceResponseSchema } from '../../lib/openapi-schemas'

describe('jsonbField', () => {
	it('accepts record of primitives', () => {
		const result = jsonbField.safeParse({ name: 'test', count: 42, active: true })
		expect(result.success).toBe(true)
	})

	it('accepts nested records', () => {
		const result = jsonbField.safeParse({
			outer: 'value',
			nested: { inner: 'deep', num: 1, flag: false, nil: null },
		})
		expect(result.success).toBe(true)
	})

	it('accepts null', () => {
		const result = jsonbField.safeParse(null)
		expect(result.success).toBe(true)
		expect(result.data).toBeNull()
	})

	it('rejects arrays', () => {
		const result = jsonbField.safeParse([1, 2, 3])
		expect(result.success).toBe(false)
	})
})

describe('workspaceResponseSchema', () => {
	const validWorkspace = {
		id: '550e8400-e29b-41d4-a716-446655440000',
		name: 'Test Workspace',
		settings: null,
		createdBy: '550e8400-e29b-41d4-a716-446655440001',
		createdAt: '2024-01-01T00:00:00Z',
		updatedAt: '2024-01-01T00:00:00Z',
	}

	it('transforms null settings to empty object', () => {
		const result = workspaceResponseSchema.parse(validWorkspace)
		expect(result.settings).toEqual({})
	})

	it('passes through non-null settings', () => {
		const result = workspaceResponseSchema.parse({
			...validWorkspace,
			settings: { theme: 'dark' },
		})
		expect(result.settings).toEqual({ theme: 'dark' })
	})
})
