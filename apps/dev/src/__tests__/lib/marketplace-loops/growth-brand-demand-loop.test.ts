import { describe, expect, it } from 'vitest'
import {
	GROWTH_BRAND_DEMAND_ACTOR_IDS,
	GROWTH_BRAND_DEMAND_LOOP,
	GROWTH_BRAND_DEMAND_SKILL_IDS,
	GROWTH_BRAND_DEMAND_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/growth-brand-demand-loop'

describe('Brand & Demand Loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_BRAND_DEMAND_LOOP.slug).toBe('brand-demand-loop')
		expect(GROWTH_BRAND_DEMAND_LOOP.name).toBe('Brand & Demand Loop')
		expect(GROWTH_BRAND_DEMAND_LOOP.useCase).toBe('Marketing')
		expect(GROWTH_BRAND_DEMAND_LOOP.version).toBe('1.0.0')
		expect(GROWTH_BRAND_DEMAND_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships five actors and their triggers, no duplicates', () => {
		expect(GROWTH_BRAND_DEMAND_ACTOR_IDS.length).toBe(5)
		expect(GROWTH_BRAND_DEMAND_TRIGGER_IDS.length).toBe(5)
		expect(new Set(GROWTH_BRAND_DEMAND_ACTOR_IDS).size).toBe(GROWTH_BRAND_DEMAND_ACTOR_IDS.length)
		expect(new Set(GROWTH_BRAND_DEMAND_TRIGGER_IDS).size).toBe(
			GROWTH_BRAND_DEMAND_TRIGGER_IDS.length,
		)
	})

	it('gives GROWTH_BRAND_DEMAND_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GROWTH_BRAND_DEMAND_SKILL_IDS)).toBe(true)
		expect(new Set(GROWTH_BRAND_DEMAND_SKILL_IDS).size).toBe(GROWTH_BRAND_DEMAND_SKILL_IDS.length)
	})
})
