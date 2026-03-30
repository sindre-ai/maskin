import { describe, expect, it } from 'vitest'
import { jsonbField, workspaceResponseSchema } from '../../lib/openapi-schemas'
import { buildWorkspace } from '../factories'

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
	const ws = buildWorkspace({ settings: null })
	const validWorkspace = {
		...ws,
		createdAt: ws.createdAt.toISOString(),
		updatedAt: ws.updatedAt.toISOString(),
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
