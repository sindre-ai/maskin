import { describe, expect, it } from 'vitest'
import {
	GROWTH_LEAD_GEN_ACTOR_IDS,
	GROWTH_LEAD_GEN_PACKAGE,
	GROWTH_LEAD_GEN_SKILL_IDS,
	GROWTH_LEAD_GEN_TRIGGER_IDS,
} from '../../../lib/catalog-packages/growth-lead-gen-package'

describe('Lead Gen & Qualification Loop package definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_LEAD_GEN_PACKAGE.slug).toBe('lead-gen-qualification-loop')
		expect(GROWTH_LEAD_GEN_PACKAGE.name).toBe('Lead Gen & Qualification Loop')
		expect(GROWTH_LEAD_GEN_PACKAGE.useCase).toBe('Sales')
		expect(GROWTH_LEAD_GEN_PACKAGE.version).toBe('1.0.0')
		expect(GROWTH_LEAD_GEN_PACKAGE.description.length).toBeGreaterThan(0)
	})

	it('ships three actors and their triggers, no duplicates', () => {
		expect(GROWTH_LEAD_GEN_ACTOR_IDS.length).toBe(3)
		expect(GROWTH_LEAD_GEN_TRIGGER_IDS.length).toBe(12)
		expect(new Set(GROWTH_LEAD_GEN_ACTOR_IDS).size).toBe(GROWTH_LEAD_GEN_ACTOR_IDS.length)
		expect(new Set(GROWTH_LEAD_GEN_TRIGGER_IDS).size).toBe(GROWTH_LEAD_GEN_TRIGGER_IDS.length)
	})

	it('gives GROWTH_LEAD_GEN_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GROWTH_LEAD_GEN_SKILL_IDS)).toBe(true)
		expect(new Set(GROWTH_LEAD_GEN_SKILL_IDS).size).toBe(GROWTH_LEAD_GEN_SKILL_IDS.length)
	})
})
