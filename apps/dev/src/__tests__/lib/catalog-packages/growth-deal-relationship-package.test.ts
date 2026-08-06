import { describe, expect, it } from 'vitest'
import {
	GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS,
	GROWTH_DEAL_RELATIONSHIP_PACKAGE,
	GROWTH_DEAL_RELATIONSHIP_SKILL_IDS,
	GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS,
} from '../../../lib/catalog-packages/growth-deal-relationship-package'

describe('Deal & Relationship Loop package definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_DEAL_RELATIONSHIP_PACKAGE.slug).toBe('deal-relationship-loop')
		expect(GROWTH_DEAL_RELATIONSHIP_PACKAGE.name).toBe('Deal & Relationship Loop')
		expect(GROWTH_DEAL_RELATIONSHIP_PACKAGE.useCase).toBe('Sales')
		expect(GROWTH_DEAL_RELATIONSHIP_PACKAGE.version).toBe('1.0.0')
		expect(GROWTH_DEAL_RELATIONSHIP_PACKAGE.description.length).toBeGreaterThan(0)
	})

	it('ships three actors and their triggers, no duplicates', () => {
		expect(GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS.length).toBe(3)
		expect(GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS.length).toBe(5)
		expect(new Set(GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS).size).toBe(
			GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS.length,
		)
		expect(new Set(GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS).size).toBe(
			GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS.length,
		)
	})

	it('gives GROWTH_DEAL_RELATIONSHIP_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GROWTH_DEAL_RELATIONSHIP_SKILL_IDS)).toBe(true)
		expect(new Set(GROWTH_DEAL_RELATIONSHIP_SKILL_IDS).size).toBe(
			GROWTH_DEAL_RELATIONSHIP_SKILL_IDS.length,
		)
	})
})
