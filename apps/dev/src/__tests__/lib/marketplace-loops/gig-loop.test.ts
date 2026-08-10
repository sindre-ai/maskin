import { describe, expect, it } from 'vitest'
import {
	GIG_LOOP,
	GIG_LOOP_ACTOR_IDS,
	GIG_LOOP_SKILL_IDS,
	GIG_LOOP_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/gig-loop'

describe('Gig Loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GIG_LOOP.slug).toBe('gig-loop')
		expect(GIG_LOOP.name).toBe('Gig Loop')
		expect(GIG_LOOP.useCase).toBe('Consulting')
		expect(GIG_LOOP.version).toBe('1.0.0')
		expect(GIG_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships three actors and five triggers, no duplicates', () => {
		expect(GIG_LOOP_ACTOR_IDS.length).toBe(3)
		expect(GIG_LOOP_TRIGGER_IDS.length).toBe(5)
		expect(new Set(GIG_LOOP_ACTOR_IDS).size).toBe(GIG_LOOP_ACTOR_IDS.length)
		expect(new Set(GIG_LOOP_TRIGGER_IDS).size).toBe(GIG_LOOP_TRIGGER_IDS.length)
	})

	it('gives GIG_LOOP_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GIG_LOOP_SKILL_IDS)).toBe(true)
		expect(new Set(GIG_LOOP_SKILL_IDS).size).toBe(GIG_LOOP_SKILL_IDS.length)
	})
})
