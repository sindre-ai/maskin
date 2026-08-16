import { describe, expect, it } from 'vitest'
import {
	GROWTH_CONTENT_INSIGHT_ACTOR_IDS,
	GROWTH_CONTENT_INSIGHT_LOOP,
	GROWTH_CONTENT_INSIGHT_SKILL_IDS,
	GROWTH_CONTENT_INSIGHT_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/growth-content-insight-loop'

describe('Content & Insight Loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_CONTENT_INSIGHT_LOOP.slug).toBe('content-insight-loop')
		expect(GROWTH_CONTENT_INSIGHT_LOOP.name).toBe('Content & Insight Loop')
		expect(GROWTH_CONTENT_INSIGHT_LOOP.useCase).toBe('Marketing')
		expect(GROWTH_CONTENT_INSIGHT_LOOP.version).toBe('1.0.0')
		expect(GROWTH_CONTENT_INSIGHT_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships three actors and their triggers, no duplicates', () => {
		expect(GROWTH_CONTENT_INSIGHT_ACTOR_IDS.length).toBe(3)
		expect(GROWTH_CONTENT_INSIGHT_TRIGGER_IDS.length).toBe(13)
		expect(new Set(GROWTH_CONTENT_INSIGHT_ACTOR_IDS).size).toBe(
			GROWTH_CONTENT_INSIGHT_ACTOR_IDS.length,
		)
		expect(new Set(GROWTH_CONTENT_INSIGHT_TRIGGER_IDS).size).toBe(
			GROWTH_CONTENT_INSIGHT_TRIGGER_IDS.length,
		)
	})

	it('gives GROWTH_CONTENT_INSIGHT_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GROWTH_CONTENT_INSIGHT_SKILL_IDS)).toBe(true)
		expect(new Set(GROWTH_CONTENT_INSIGHT_SKILL_IDS).size).toBe(
			GROWTH_CONTENT_INSIGHT_SKILL_IDS.length,
		)
	})
})
