import { describe, expect, it } from 'vitest'
import {
	MESH_FIRM_GIG_ACTOR_IDS,
	MESH_FIRM_GIG_LOOP,
	MESH_FIRM_GIG_SKILL_IDS,
	MESH_FIRM_GIG_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/mesh-firm-gig-loop'

describe('Gig Loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(MESH_FIRM_GIG_LOOP.slug).toBe('gig-loop')
		expect(MESH_FIRM_GIG_LOOP.name).toBe('Gig Loop')
		expect(MESH_FIRM_GIG_LOOP.useCase).toBe('Consulting')
		expect(MESH_FIRM_GIG_LOOP.version).toBe('1.0.0')
		expect(MESH_FIRM_GIG_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships three actors and five triggers, no duplicates', () => {
		expect(MESH_FIRM_GIG_ACTOR_IDS.length).toBe(3)
		expect(MESH_FIRM_GIG_TRIGGER_IDS.length).toBe(5)
		expect(new Set(MESH_FIRM_GIG_ACTOR_IDS).size).toBe(MESH_FIRM_GIG_ACTOR_IDS.length)
		expect(new Set(MESH_FIRM_GIG_TRIGGER_IDS).size).toBe(MESH_FIRM_GIG_TRIGGER_IDS.length)
	})

	it('gives MESH_FIRM_GIG_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(MESH_FIRM_GIG_SKILL_IDS)).toBe(true)
		expect(new Set(MESH_FIRM_GIG_SKILL_IDS).size).toBe(MESH_FIRM_GIG_SKILL_IDS.length)
	})
})
