import workExtension from '@maskin/ext-work/server'
import { describe, expect, it } from 'vitest'

describe('work extension — commitment registration (renamed from `loop` in T1 of bet/loops-first-class)', () => {
	it('registers commitment as an object type with the shape from the architecture lock', () => {
		const commitment = workExtension.objectTypes.find((t) => t.type === 'commitment')
		expect(commitment).toBeDefined()
		expect(commitment?.label).toBe('Commitment')
		expect(commitment?.defaultStatuses).toEqual(['holding', 'at-risk', 'breached'])
	})

	it('lists commitment metadata fields as optional', () => {
		const commitment = workExtension.objectTypes.find((t) => t.type === 'commitment')
		const names = commitment?.defaultFields?.map((f) => f.name) ?? []
		expect(names).toEqual(['floor', 'cadence', 'source_bet_id', 'last_breach_at'])
		for (const field of commitment?.defaultFields ?? []) {
			expect(field.required ?? false).toBe(false)
		}
	})

	it('exposes commitment in defaultSettings.statuses with holding as the default', () => {
		expect(workExtension.defaultSettings?.statuses?.commitment).toEqual([
			'holding',
			'at-risk',
			'breached',
		])
		expect(workExtension.defaultSettings?.statuses?.commitment?.[0]).toBe('holding')
	})

	it('exposes commitment in defaultSettings.display_names', () => {
		expect(workExtension.defaultSettings?.display_names?.commitment).toBe('Commitment')
	})

	it('exposes commitment metadata field_definitions in defaultSettings', () => {
		const fields = workExtension.defaultSettings?.field_definitions?.commitment ?? []
		expect(fields.map((f) => f.name)).toEqual([
			'floor',
			'cadence',
			'source_bet_id',
			'last_breach_at',
		])
	})
})

describe('work extension — loop registration (T2 of bet/loops-first-class, new pipeline concept)', () => {
	it('registers loop with the new multi-agent-pipeline shape from T1', () => {
		const loop = workExtension.objectTypes.find((t) => t.type === 'loop')
		expect(loop).toBeDefined()
		expect(loop?.label).toBe('Loop')
		expect(loop?.defaultStatuses).toEqual(['running', 'waiting', 'paused', 'archived'])
	})

	it('lists loop metadata fields as optional', () => {
		const loop = workExtension.objectTypes.find((t) => t.type === 'loop')
		const names = loop?.defaultFields?.map((f) => f.name) ?? []
		expect(names).toEqual([
			'entry_condition',
			'close_condition',
			'human_decision_points',
			'installed_from_package_id',
		])
		for (const field of loop?.defaultFields ?? []) {
			expect(field.required ?? false).toBe(false)
		}
	})

	it('exposes loop in defaultSettings.statuses with running as the default', () => {
		expect(workExtension.defaultSettings?.statuses?.loop).toEqual([
			'running',
			'waiting',
			'paused',
			'archived',
		])
		expect(workExtension.defaultSettings?.statuses?.loop?.[0]).toBe('running')
	})

	it('exposes loop in defaultSettings.display_names', () => {
		expect(workExtension.defaultSettings?.display_names?.loop).toBe('Loop')
	})
})
