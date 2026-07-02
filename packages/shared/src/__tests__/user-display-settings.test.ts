import { describe, expect, it } from 'vitest'
import {
	ALL_TYPES_KEY,
	displaySettingsBodySchema,
	userDisplaySettingsParamsSchema,
} from '../schemas/user-display-settings'

describe('displaySettingsBodySchema', () => {
	it('accepts a fully-specified settings blob', () => {
		const result = displaySettingsBodySchema.parse({
			view: 'list',
			sort: 'title',
			order: 'asc',
			groupBy: 'status',
			filters: { status: 'active', driver: 'me' },
			columnVisibility: { title: true, 'metadata.priority': false },
		})
		expect(result.view).toBe('list')
		expect(result.columnVisibility).toEqual({ title: true, 'metadata.priority': false })
	})

	it('accepts the empty object', () => {
		expect(displaySettingsBodySchema.parse({})).toEqual({})
	})

	it('rejects unknown top-level keys (strict)', () => {
		expect(() => displaySettingsBodySchema.parse({ unknownKey: 'x' })).toThrow()
	})

	it('rejects a columnVisibility key longer than 256 chars', () => {
		const longKey = 'a'.repeat(257)
		expect(() =>
			displaySettingsBodySchema.parse({ columnVisibility: { [longKey]: true } }),
		).toThrow()
	})

	it('accepts a columnVisibility map at the 200-entry cap', () => {
		const vis: Record<string, boolean> = {}
		for (let i = 0; i < 200; i++) vis[`col_${i}`] = i % 2 === 0
		const result = displaySettingsBodySchema.parse({ columnVisibility: vis })
		expect(Object.keys(result.columnVisibility ?? {})).toHaveLength(200)
	})

	it('rejects a columnVisibility map with more than 200 entries', () => {
		const vis: Record<string, boolean> = {}
		for (let i = 0; i < 201; i++) vis[`col_${i}`] = true
		expect(() => displaySettingsBodySchema.parse({ columnVisibility: vis })).toThrow(/at most 200/)
	})
})

describe('userDisplaySettingsParamsSchema', () => {
	it('accepts a concrete object type', () => {
		expect(userDisplaySettingsParamsSchema.parse({ object_type: 'task' })).toEqual({
			object_type: 'task',
		})
	})

	it('accepts the All-tab sentinel', () => {
		expect(userDisplaySettingsParamsSchema.parse({ object_type: ALL_TYPES_KEY })).toEqual({
			object_type: '__all__',
		})
	})

	it('still rejects malformed object types', () => {
		expect(() => userDisplaySettingsParamsSchema.parse({ object_type: 'Not-Valid' })).toThrow()
		expect(() => userDisplaySettingsParamsSchema.parse({ object_type: '__bogus__' })).toThrow()
	})
})
