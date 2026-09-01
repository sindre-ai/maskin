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
	// buildWorkspace() returns a DB row, which carries the raw `enterprise_granted`
	// column. The response schema carries the derived `enterprise` status instead
	// (see serializeWorkspace in routes/workspaces.ts), so map it here.
	const { enterpriseGranted, ...ws } = buildWorkspace({ settings: null })
	const validWorkspace = {
		...ws,
		enterprise: enterpriseGranted,
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
