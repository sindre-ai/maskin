import { describe, expect, it } from 'vitest'
import { displaySettingsBodySchema } from '../schemas/user-display-settings'

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

	describe('timelineView (AC-T7)', () => {
		it('accepts timelineView=timeline', () => {
			expect(displaySettingsBodySchema.parse({ timelineView: 'timeline' }).timelineView).toBe(
				'timeline',
			)
		})

		it('accepts timelineView=table alongside other settings', () => {
			const parsed = displaySettingsBodySchema.parse({
				view: 'list',
				sort: 'createdAt',
				order: 'desc',
				timelineView: 'table',
			})
			expect(parsed.timelineView).toBe('table')
			expect(parsed.view).toBe('list')
		})

		it('rejects unknown timelineView values', () => {
			expect(() => displaySettingsBodySchema.parse({ timelineView: 'graph' })).toThrow()
		})
	})
})
