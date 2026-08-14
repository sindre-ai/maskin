import { describe, expect, it } from 'vitest'
import {
	GROWTH_SDR_OUTREACH_ACTOR_IDS,
	GROWTH_SDR_OUTREACH_LOOP,
	GROWTH_SDR_OUTREACH_SKILL_IDS,
	GROWTH_SDR_OUTREACH_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/growth-sdr-outreach-loop'

describe('SDR Outreach Loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(GROWTH_SDR_OUTREACH_LOOP.slug).toBe('sdr-outreach-loop')
		expect(GROWTH_SDR_OUTREACH_LOOP.name).toBe('SDR Outreach Loop')
		expect(GROWTH_SDR_OUTREACH_LOOP.useCase).toBe('Sales')
		expect(GROWTH_SDR_OUTREACH_LOOP.version).toBe('1.0.0')
		expect(GROWTH_SDR_OUTREACH_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships four actors and their triggers, no duplicates', () => {
		expect(GROWTH_SDR_OUTREACH_ACTOR_IDS.length).toBe(4)
		expect(GROWTH_SDR_OUTREACH_TRIGGER_IDS.length).toBe(21)
		expect(new Set(GROWTH_SDR_OUTREACH_ACTOR_IDS).size).toBe(GROWTH_SDR_OUTREACH_ACTOR_IDS.length)
		expect(new Set(GROWTH_SDR_OUTREACH_TRIGGER_IDS).size).toBe(
			GROWTH_SDR_OUTREACH_TRIGGER_IDS.length,
		)
	})

	it('gives GROWTH_SDR_OUTREACH_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(GROWTH_SDR_OUTREACH_SKILL_IDS)).toBe(true)
		expect(new Set(GROWTH_SDR_OUTREACH_SKILL_IDS).size).toBe(GROWTH_SDR_OUTREACH_SKILL_IDS.length)
	})
})
