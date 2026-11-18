import { describe, expect, it } from 'vitest'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import {
	MARKET_WATCH_ACTOR_IDS,
	MARKET_WATCH_ACTOR_OWNER,
	MARKET_WATCH_LOOP,
	MARKET_WATCH_SKILL_IDS,
	MARKET_WATCH_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/market-watch-loop'

describe('Market & Competitor Watch loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(MARKET_WATCH_LOOP.slug).toBe('market-competitor-watch-loop')
		expect(MARKET_WATCH_LOOP.name).toBe('Market & Competitor Watch')
		expect(MARKET_WATCH_LOOP.useCase).toBe('Discovery')
		expect(MARKET_WATCH_LOOP.version).toBe('1.1.1')
		expect(MARKET_WATCH_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships entry condition, close condition and tags, with no targets', () => {
		const settings = loopSettingsSchema.parse(MARKET_WATCH_LOOP.settings)
		expect(settings.entryCondition).toMatch(/weekly sweep/)
		expect(settings.entryCondition).toMatch(/monthly revalidation/)
		expect(settings.closeCondition).toMatch(/no end state/)
		expect(settings.tags).toEqual(['Market'])
		expect(settings.targets).toBeUndefined()
	})

	it('ships three actors, four triggers and four skills, no duplicates', () => {
		expect(MARKET_WATCH_ACTOR_IDS.length).toBe(3)
		expect(MARKET_WATCH_TRIGGER_IDS.length).toBe(4)
		expect(MARKET_WATCH_SKILL_IDS.length).toBe(4)
		expect(new Set(MARKET_WATCH_TRIGGER_IDS).size).toBe(MARKET_WATCH_TRIGGER_IDS.length)
		expect(new Set(MARKET_WATCH_SKILL_IDS).size).toBe(MARKET_WATCH_SKILL_IDS.length)
	})

	it('has one Monday briefing check, not two', () => {
		const mondayChecks = MARKET_WATCH_TRIGGER_IDS.map(getTriggerData).filter((t) =>
			(t.config as { expression?: string }).expression?.endsWith(' * * 1'),
		)
		expect(mondayChecks.map((t) => t.name)).toEqual(['Weekly briefing check'])
	})

	it('does not tell the Briefing Owner to own a second Monday check', () => {
		const prompt = getActorData(MARKET_WATCH_ACTOR_OWNER).systemPrompt ?? ''
		expect(prompt).not.toMatch(/later on Monday/)
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
			MARKET_WATCH_LOOP.settings.entryCondition,
			MARKET_WATCH_LOOP.settings.closeCondition,
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
	})

	it('says flow, not loop, in the text a person reads', () => {
		const texts = [
			MARKET_WATCH_LOOP.description,
			...MARKET_WATCH_ACTOR_IDS.map((id) => {
				const a = getActorData(id)
				return `${a.name} ${a.description} ${a.systemPrompt}`
			}),
			...MARKET_WATCH_TRIGGER_IDS.map((id) => getTriggerData(id).actionPrompt ?? ''),
			...MARKET_WATCH_SKILL_IDS.map((id) => getSkillData(id).content ?? ''),
		]
		// Tool and object type names (list_loops, in_loop) are one word, so they do not match.
		for (const text of texts) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of MARKET_WATCH_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})
})
