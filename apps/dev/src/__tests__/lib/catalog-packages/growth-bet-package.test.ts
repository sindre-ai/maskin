import { describe, expect, it } from 'vitest'
import {
	GROWTH_BET_ACTOR_IDS,
	GROWTH_BET_PACKAGE,
	GROWTH_BET_SKILL_IDS,
	GROWTH_BET_TRIGGER_IDS,
} from '../../../lib/catalog-packages/growth-bet-package'

describe('Growth Bet Loop package definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_BET_PACKAGE.slug).toBe('growth-bet-loop')
		expect(GROWTH_BET_PACKAGE.name).toBe('Growth Bet Loop')
		expect(GROWTH_BET_PACKAGE.useCase).toBe('Growth')
		expect(GROWTH_BET_PACKAGE.version).toBe('1.0.0')
		expect(GROWTH_BET_PACKAGE.description.length).toBeGreaterThan(0)
	})

	it('ships three actors and their triggers, no duplicates', () => {
		expect(GROWTH_BET_ACTOR_IDS.length).toBe(3)
		expect(GROWTH_BET_TRIGGER_IDS.length).toBe(16)
		expect(new Set(GROWTH_BET_ACTOR_IDS).size).toBe(GROWTH_BET_ACTOR_IDS.length)
		expect(new Set(GROWTH_BET_TRIGGER_IDS).size).toBe(GROWTH_BET_TRIGGER_IDS.length)
	})

	it('gives GROWTH_BET_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GROWTH_BET_SKILL_IDS)).toBe(true)
		expect(new Set(GROWTH_BET_SKILL_IDS).size).toBe(GROWTH_BET_SKILL_IDS.length)
	})
})
