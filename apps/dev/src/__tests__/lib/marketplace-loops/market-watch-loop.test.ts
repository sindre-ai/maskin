import { describe, expect, it } from 'vitest'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import {
	MARKET_WATCH_ACTOR_IDS,
	MARKET_WATCH_LOOP,
	MARKET_WATCH_SKILL_IDS,
	MARKET_WATCH_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/market-watch-loop'

describe('Market & Competitor Watch loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(MARKET_WATCH_LOOP.slug).toBe('market-competitor-watch-loop')
		expect(MARKET_WATCH_LOOP.name).toBe('Market & Competitor Watch')
		expect(MARKET_WATCH_LOOP.useCase).toBe('Discovery')
		expect(MARKET_WATCH_LOOP.version).toBe('1.0.0')
		expect(MARKET_WATCH_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships three actors, five triggers and four skills, no duplicates', () => {
		expect(MARKET_WATCH_ACTOR_IDS.length).toBe(3)
		expect(MARKET_WATCH_TRIGGER_IDS.length).toBe(5)
		expect(MARKET_WATCH_SKILL_IDS.length).toBe(4)
		expect(new Set(MARKET_WATCH_TRIGGER_IDS).size).toBe(MARKET_WATCH_TRIGGER_IDS.length)
		expect(new Set(MARKET_WATCH_SKILL_IDS).size).toBe(MARKET_WATCH_SKILL_IDS.length)
	})

	it('wires every trigger to a published actor and every skill to published actors only', () => {
		const actorIds = new Set<string>(MARKET_WATCH_ACTOR_IDS)
		for (const id of MARKET_WATCH_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of MARKET_WATCH_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		const texts = [
			MARKET_WATCH_LOOP.description,
			...MARKET_WATCH_ACTOR_IDS.map((id) => {
				const a = getActorData(id)
				return `${a.name} ${a.description} ${a.systemPrompt}`
			}),
			...MARKET_WATCH_TRIGGER_IDS.map((id) => getTriggerData(id).actionPrompt ?? ''),
			...MARKET_WATCH_SKILL_IDS.map((id) => getSkillData(id).content ?? ''),
		]
		for (const text of texts) {
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/\u2014|assum/i)
		}
		for (const id of MARKET_WATCH_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})
})
