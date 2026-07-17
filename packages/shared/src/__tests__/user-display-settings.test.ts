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

	describe('groupExpanded and firstVisibleRowId', () => {
		it('accepts a groupExpanded map alongside other settings', () => {
			const parsed = displaySettingsBodySchema.parse({
				groupBy: 'status',
				groupExpanded: { 'metadata.status:active': true, 'metadata.status:done': false },
			})
			expect(parsed.groupExpanded).toEqual({
				'metadata.status:active': true,
				'metadata.status:done': false,
			})
		})

		it('accepts firstVisibleRowId as a row id', () => {
			const parsed = displaySettingsBodySchema.parse({ firstVisibleRowId: 'row_42' })
			expect(parsed.firstVisibleRowId).toBe('row_42')
		})

		it('accepts firstVisibleRowId=null to signal cleared state', () => {
			const parsed = displaySettingsBodySchema.parse({ firstVisibleRowId: null })
			expect(parsed.firstVisibleRowId).toBeNull()
		})

		it('rejects a groupExpanded map with more than 200 entries', () => {
			const groupExpanded: Record<string, boolean> = {}
			for (let i = 0; i < 201; i++) groupExpanded[`group_${i}`] = true
			expect(() => displaySettingsBodySchema.parse({ groupExpanded })).toThrow(/at most 200/)
		})

		it('leaves legacy blobs without the new fields untouched', () => {
			const legacy = { view: 'list' as const, sort: 'title', order: 'asc' as const }
			const parsed = displaySettingsBodySchema.parse(legacy)
			expect(parsed.groupExpanded).toBeUndefined()
			expect(parsed.firstVisibleRowId).toBeUndefined()
		})
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

	it('accepts filters.metadata as a field->value record', () => {
		const result = displaySettingsBodySchema.parse({
			filters: { status: 'active', metadata: { segment: 'enterprise', confidence: 'high' } },
		})
		expect(result.filters?.metadata).toEqual({ segment: 'enterprise', confidence: 'high' })
	})

	it('rejects a filters.metadata map with more than 50 entries', () => {
		const metadata: Record<string, string> = {}
		for (let i = 0; i < 51; i++) metadata[`field_${i}`] = 'x'
		expect(() => displaySettingsBodySchema.parse({ filters: { metadata } })).toThrow(/at most 50/)
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
