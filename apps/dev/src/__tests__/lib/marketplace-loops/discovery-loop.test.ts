import { describe, expect, it } from 'vitest'
import {
	DISCOVERY_ACTOR_IDS,
	DISCOVERY_LOOP,
	DISCOVERY_SKILL_IDS,
	DISCOVERY_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/discovery-loop'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'

describe('Product Discovery Loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(DISCOVERY_LOOP.slug).toBe('product-discovery-loop')
		expect(DISCOVERY_LOOP.name).toBe('Product Discovery Loop')
		expect(DISCOVERY_LOOP.useCase).toBe('Discovery')
		expect(DISCOVERY_LOOP.version).toBe('1.0.0')
		expect(DISCOVERY_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships three actors, six triggers and three skills, no duplicates', () => {
		expect(DISCOVERY_ACTOR_IDS.length).toBe(3)
		expect(DISCOVERY_TRIGGER_IDS.length).toBe(6)
		expect(DISCOVERY_SKILL_IDS.length).toBe(3)
		expect(new Set(DISCOVERY_ACTOR_IDS).size).toBe(DISCOVERY_ACTOR_IDS.length)
		expect(new Set(DISCOVERY_TRIGGER_IDS).size).toBe(DISCOVERY_TRIGGER_IDS.length)
		expect(new Set(DISCOVERY_SKILL_IDS).size).toBe(DISCOVERY_SKILL_IDS.length)
	})

	it('wires every trigger to a published actor and every skill to published actors', () => {
		const actorIds = new Set<string>(DISCOVERY_ACTOR_IDS)
		for (const id of DISCOVERY_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of DISCOVERY_SKILL_IDS) {
			const { attachedActorIds } = getSkillData(id)
			expect(attachedActorIds.length).toBeGreaterThan(0)
			for (const actorId of attachedActorIds) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	// This bundle is a template for any workspace: nothing in it may name the
	// workspace, people or agents it was derived from, or carry a source id.
	it('carries no workspace-specific text', () => {
		const text = JSON.stringify([
			DISCOVERY_LOOP,
			...DISCOVERY_ACTOR_IDS.map(getActorData),
			...DISCOVERY_TRIGGER_IDS.map(getTriggerData),
			...DISCOVERY_SKILL_IDS.map(getSkillData),
		])
		const forbidden = [
			/sebastian|sebk|magnus/i,
			/vaerksted|skjald|meshfirm/i,
			/\bCTO\b|\bCPO\b|chief of staff/i,
			/assum/i,
		]
		for (const pattern of forbidden) expect(text).not.toMatch(pattern)

		const ownIds = new Set<string>([
			...DISCOVERY_ACTOR_IDS,
			...DISCOVERY_TRIGGER_IDS,
			...DISCOVERY_SKILL_IDS,
		])
		const foundIds =
			text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []
		for (const id of foundIds) expect(ownIds.has(id)).toBe(true)
	})
})
