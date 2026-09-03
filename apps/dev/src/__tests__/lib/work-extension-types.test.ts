import workExtension from '@maskin/ext-work/server'
import { describe, expect, it } from 'vitest'

describe('work extension — loop registration (T2 of bet/loops-first-class, new pipeline concept)', () => {
	it('registers loop with the new multi-agent-pipeline shape from T1', () => {
		const loop = workExtension.objectTypes.find((t) => t.type === 'loop')
		expect(loop).toBeDefined()
		expect(loop?.label).toBe('Loop')
		expect(loop?.defaultStatuses).toEqual([
			'draft',
			'paused',
			'learning',
			'supervised',
			'fully_autonomous',
		])
	})

	it('lists loop metadata fields as optional', () => {
		const loop = workExtension.objectTypes.find((t) => t.type === 'loop')
		const names = loop?.defaultFields?.map((f) => f.name) ?? []
		expect(names).toEqual([
			'entry_condition',
			'close_condition',
			'installed_from_marketplace_loop_id',
		])
		for (const field of loop?.defaultFields ?? []) {
			expect(field.required ?? false).toBe(false)
		}
	})

	it('exposes loop in defaultSettings.statuses with draft as the default', () => {
		expect(workExtension.defaultSettings?.statuses?.loop).toEqual([
			'draft',
			'paused',
			'learning',
			'supervised',
			'fully_autonomous',
		])
		expect(workExtension.defaultSettings?.statuses?.loop?.[0]).toBe('draft')
	})

	it('exposes loop in defaultSettings.display_names', () => {
		expect(workExtension.defaultSettings?.display_names?.loop).toBe('Loop')
	})
})
