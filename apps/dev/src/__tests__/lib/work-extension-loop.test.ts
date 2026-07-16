import workExtension from '@maskin/ext-work/server'
import { describe, expect, it } from 'vitest'

describe('work extension — loop registration', () => {
	it('registers loop as an object type with the shape from the architecture lock', () => {
		const loop = workExtension.objectTypes.find((t) => t.type === 'loop')
		expect(loop).toBeDefined()
		expect(loop?.label).toBe('Loop')
		expect(loop?.defaultStatuses).toEqual(['holding', 'at-risk', 'breached'])
	})

	it('lists loop metadata fields as optional', () => {
		const loop = workExtension.objectTypes.find((t) => t.type === 'loop')
		const names = loop?.defaultFields?.map((f) => f.name) ?? []
		expect(names).toEqual(['floor', 'cadence', 'source_bet_id', 'last_breach_at'])
		for (const field of loop?.defaultFields ?? []) {
			expect(field.required ?? false).toBe(false)
		}
	})

	it('exposes loop in defaultSettings.statuses with holding as the default', () => {
		expect(workExtension.defaultSettings?.statuses?.loop).toEqual([
			'holding',
			'at-risk',
			'breached',
		])
		expect(workExtension.defaultSettings?.statuses?.loop?.[0]).toBe('holding')
	})

	it('exposes loop in defaultSettings.display_names', () => {
		expect(workExtension.defaultSettings?.display_names?.loop).toBe('Loop')
	})

	it('exposes loop metadata field_definitions in defaultSettings', () => {
		const fields = workExtension.defaultSettings?.field_definitions?.loop ?? []
		expect(fields.map((f) => f.name)).toEqual([
			'floor',
			'cadence',
			'source_bet_id',
			'last_breach_at',
		])
	})
})
