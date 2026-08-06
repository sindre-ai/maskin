import { describe, expect, it } from 'vitest'
import {
	GROWTH_OPS_KNOWLEDGE_ACTOR_IDS,
	GROWTH_OPS_KNOWLEDGE_PACKAGE,
	GROWTH_OPS_KNOWLEDGE_SKILL_IDS,
	GROWTH_OPS_KNOWLEDGE_TRIGGER_IDS,
} from '../../../lib/catalog-packages/growth-ops-knowledge-package'

describe('Ops & Knowledge Loop package definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_OPS_KNOWLEDGE_PACKAGE.slug).toBe('ops-knowledge-loop')
		expect(GROWTH_OPS_KNOWLEDGE_PACKAGE.name).toBe('Ops & Knowledge Loop')
		expect(GROWTH_OPS_KNOWLEDGE_PACKAGE.useCase).toBe('Operations')
		expect(GROWTH_OPS_KNOWLEDGE_PACKAGE.version).toBe('1.0.0')
		expect(GROWTH_OPS_KNOWLEDGE_PACKAGE.description.length).toBeGreaterThan(0)
	})

	it('ships four actors and their triggers, no duplicates', () => {
		expect(GROWTH_OPS_KNOWLEDGE_ACTOR_IDS.length).toBe(4)
		expect(GROWTH_OPS_KNOWLEDGE_TRIGGER_IDS.length).toBe(17)
		expect(new Set(GROWTH_OPS_KNOWLEDGE_ACTOR_IDS).size).toBe(GROWTH_OPS_KNOWLEDGE_ACTOR_IDS.length)
		expect(new Set(GROWTH_OPS_KNOWLEDGE_TRIGGER_IDS).size).toBe(
			GROWTH_OPS_KNOWLEDGE_TRIGGER_IDS.length,
		)
	})

	it('gives GROWTH_OPS_KNOWLEDGE_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GROWTH_OPS_KNOWLEDGE_SKILL_IDS)).toBe(true)
		expect(new Set(GROWTH_OPS_KNOWLEDGE_SKILL_IDS).size).toBe(GROWTH_OPS_KNOWLEDGE_SKILL_IDS.length)
	})
})
