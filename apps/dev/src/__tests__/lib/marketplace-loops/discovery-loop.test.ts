import { describe, expect, it } from 'vitest'
import {
	DISCOVERY_ACTOR_CPO,
	DISCOVERY_ACTOR_IDS,
	DISCOVERY_ACTOR_PRODUCT_DISCOVERY_AGENT,
	DISCOVERY_ACTOR_STRATEGIST,
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
		expect(DISCOVERY_LOOP.version).toBe('1.1.0')
		expect(DISCOVERY_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships the CPO, the Strategist and the Product Discovery Agent with six triggers and fourteen skills', () => {
		expect(DISCOVERY_ACTOR_IDS.length).toBe(3)
		expect(DISCOVERY_TRIGGER_IDS.length).toBe(6)
		expect(DISCOVERY_SKILL_IDS.length).toBe(14)
		expect(new Set(DISCOVERY_ACTOR_IDS).size).toBe(DISCOVERY_ACTOR_IDS.length)
		expect(new Set(DISCOVERY_TRIGGER_IDS).size).toBe(DISCOVERY_TRIGGER_IDS.length)
		expect(new Set(DISCOVERY_SKILL_IDS).size).toBe(DISCOVERY_SKILL_IDS.length)
	})

	it('names the agents CPO, Strategist and Product Discovery Agent', () => {
		expect(DISCOVERY_ACTOR_IDS.map((id) => getActorData(id).name)).toEqual([
			'Product Discovery Agent',
			'CPO',
			'Strategist',
		])
	})

	it('carries the six loop triggers, each driven by the right agent', () => {
		const byName = Object.fromEntries(
			DISCOVERY_TRIGGER_IDS.map((id) => {
				const t = getTriggerData(id)
				return [t.name, t.targetActorId]
			}),
		)
		expect(byName).toEqual({
			'Triage new insight': DISCOVERY_ACTOR_PRODUCT_DISCOVERY_AGENT,
			'Signal sweep (Mon, Wed, Fri 03:30 UTC)': DISCOVERY_ACTOR_PRODUCT_DISCOVERY_AGENT,
			'Re-cluster and hand over backlog (weekdays 02:30 UTC, one batch)':
				DISCOVERY_ACTOR_PRODUCT_DISCOVERY_AGENT,
			'Weekly Discovery Digest (Mon 04:30 UTC)': DISCOVERY_ACTOR_PRODUCT_DISCOVERY_AGENT,
			'Rolling revalidation (weekdays 05:00 UTC)': DISCOVERY_ACTOR_CPO,
			'Shape the bet': DISCOVERY_ACTOR_STRATEGIST,
		})
	})

	it('attaches to each agent the skills it has in the source workspace', () => {
		const skillNamesFor = (actorId: string) =>
			DISCOVERY_SKILL_IDS.map(getSkillData)
				.filter((s) => s.attachedActorIds.includes(actorId))
				.map((s) => s.name)
				.sort()
		const shared = [
			'ask-an-agent-first',
			'for-you-format',
			'keep-bets-simple',
			'maskin-way-of-working',
			'plain-english-voice',
			'product-operating-model',
		]
		expect(skillNamesFor(DISCOVERY_ACTOR_PRODUCT_DISCOVERY_AGENT)).toEqual(
			[...shared, 'insight-triage', 'loop-briefing-standard'].sort(),
		)
		expect(skillNamesFor(DISCOVERY_ACTOR_CPO)).toEqual([...shared, 'loop-briefing-standard'].sort())
		expect(skillNamesFor(DISCOVERY_ACTOR_STRATEGIST)).toEqual(
			[
				...shared,
				'design-implementation-discipline',
				'reshape-bet',
				'shape-bet',
				'shaped-bet-format',
				'strategist-planner-architect-roles',
				'success-event-before-active',
			].sort(),
		)
	})

	it('ships full prompts, not short rewrites', () => {
		for (const id of DISCOVERY_ACTOR_IDS) {
			expect(getActorData(id).systemPrompt?.length ?? 0).toBeGreaterThan(5000)
		}
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
	// company, people or agents it was derived from, carry a date, or carry a
	// source id. The CPO, the Strategist and the Product Discovery Agent are the
	// agents that ship, so their names are the one exception.
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
			// The product's own name is only allowed inside a skill's name
			/maskin(?!-way-of-working)/i,
			/\bCTO\b|\bCCO\b|chief of staff/i,
			/assum/i,
			// Agents that do not ship in this bundle are named by role in plain words
			/\b(Customer Success|Content Lead|Product Marketing|Head of Growth|Prospector|Events Lead|Fundraiser|Skjald PM|Product Designer|Workspace Coach|Design Studio|Product Validator|Code Reviewer|Developer|Planner|Architect|Product Insights Analyst|Signal Analyst|Bet Revalidator|Product Lead|Bet Shaper|Workspace Driver|Researcher|Product Manager|Linker)\b/,
			// Dates and years, whether written out or numeric
			/\b20\d\d\b/,
			/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/,
			/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/,
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
