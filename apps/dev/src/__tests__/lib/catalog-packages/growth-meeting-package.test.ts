import { describe, expect, it } from 'vitest'
import {
	GROWTH_MEETING_ACTOR_IDS,
	GROWTH_MEETING_PACKAGE,
	GROWTH_MEETING_SKILL_IDS,
	GROWTH_MEETING_TRIGGER_IDS,
} from '../../../lib/catalog-packages/growth-meeting-package'

describe('Meeting Loop package definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_MEETING_PACKAGE.slug).toBe('meeting-loop')
		expect(GROWTH_MEETING_PACKAGE.name).toBe('Meeting Loop')
		expect(GROWTH_MEETING_PACKAGE.useCase).toBe('Operations')
		expect(GROWTH_MEETING_PACKAGE.version).toBe('1.0.0')
		expect(GROWTH_MEETING_PACKAGE.description.length).toBeGreaterThan(0)
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
