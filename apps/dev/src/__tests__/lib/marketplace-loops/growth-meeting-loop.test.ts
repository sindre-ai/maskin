import { describe, expect, it } from 'vitest'
import {
	GROWTH_MEETING_ACTOR_IDS,
	GROWTH_MEETING_LOOP,
	GROWTH_MEETING_SKILL_IDS,
	GROWTH_MEETING_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/growth-meeting-loop'

describe('Meeting Loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_MEETING_LOOP.slug).toBe('meeting-loop')
		expect(GROWTH_MEETING_LOOP.name).toBe('Meeting Loop')
		expect(GROWTH_MEETING_LOOP.useCase).toBe('Operations')
		expect(GROWTH_MEETING_LOOP.version).toBe('1.0.0')
		expect(GROWTH_MEETING_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships two actors and their triggers, no duplicates', () => {
		expect(GROWTH_MEETING_ACTOR_IDS.length).toBe(2)
		expect(GROWTH_MEETING_TRIGGER_IDS.length).toBe(3)
		expect(new Set(GROWTH_MEETING_ACTOR_IDS).size).toBe(GROWTH_MEETING_ACTOR_IDS.length)
		expect(new Set(GROWTH_MEETING_TRIGGER_IDS).size).toBe(GROWTH_MEETING_TRIGGER_IDS.length)
	})

	it('gives GROWTH_MEETING_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GROWTH_MEETING_SKILL_IDS)).toBe(true)
		expect(new Set(GROWTH_MEETING_SKILL_IDS).size).toBe(GROWTH_MEETING_SKILL_IDS.length)
	})
})
