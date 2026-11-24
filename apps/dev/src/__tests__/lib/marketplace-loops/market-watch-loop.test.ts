import { MARKET_WATCH_ACTOR_OWNER, MARKET_WATCH_ACTOR_RESEARCHER } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import {
	MARKET_WATCH_ACTOR_IDS,
	MARKET_WATCH_LOOP,
	MARKET_WATCH_SKILL_IDS,
	MARKET_WATCH_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/market-watch-loop'

describe('Competitor watch loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(MARKET_WATCH_LOOP.slug).toBe('market-competitor-watch-loop')
		expect(MARKET_WATCH_LOOP.name).toBe('Competitor watch')
		expect(MARKET_WATCH_LOOP.useCase).toBe('Discovery')
		expect(MARKET_WATCH_LOOP.version).toBe('1.3.0')
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

	it('ships a parent checklist and eight children, driven by the Market Researcher', () => {
		const settings = loopSettingsSchema.parse(MARKET_WATCH_LOOP.settings)
		expect(settings.checklist?.title).toBe('Competitor research checklist')
		expect(settings.checklist?.driverSourceItemId).toBe(MARKET_WATCH_ACTOR_RESEARCHER)
		const titles = (settings.checklist?.items ?? []).map((i) => i.title)
		expect(titles).toEqual([
			'Name 3 to 5 direct competitors',
			'Use the same fields for each competitor',
			'Check evidence, not claims',
			'Record source URLs for each competitor',
			'Add company register data and trends',
			'Note gaps and edges',
			'Write one page per competitor and a comparison table',
			'Refresh sources and register data on schedule',
		])
		expect(new Set(titles).size).toBe(titles.length)
	})

	it('maps the refresh child to the existing monthly revalidation, with no second schedule', () => {
		const refresh = MARKET_WATCH_LOOP.settings.checklist?.items.at(-1)
		expect(refresh?.body).toContain('Monthly revalidation')
		expect(refresh?.body).toContain('do not add a second one')
		const crons = MARKET_WATCH_TRIGGER_IDS.map(getTriggerData).filter((t) => t.type === 'cron')
		expect(crons).toHaveLength(4)
	})

	it('carries the research method in the researcher and the sweep and revalidation triggers', () => {
		const prompt = getActorData(MARKET_WATCH_ACTOR_RESEARCHER).systemPrompt ?? ''
		expect(prompt).toContain('# Competitor research method')
		for (const needle of [
			'3 to 5',
			'who they sell to',
			'pricing',
			'how they sell',
			'how they position themselves',
			'Source URLs',
			'CVR',
			'last 2 to 3 years',
			'filed or estimated',
			'one comparison table',
			'date and a source',
		]) {
			expect(prompt).toContain(needle)
		}
		const byName = (name: string) =>
			MARKET_WATCH_TRIGGER_IDS.map(getTriggerData).find((t) => t.name === name)?.actionPrompt
		expect(byName('Weekly sweep')).toContain('competitor research method')
		expect(byName('Monthly revalidation')).toContain('recorded source URLs and register data')
	})

	it('starts the Briefing Owner check with the checklist and its three-question limit', () => {
		const check = MARKET_WATCH_TRIGGER_IDS.map(getTriggerData).find(
			(t) => t.name === 'Weekly briefing check',
		)
		expect(check?.actionPrompt).toMatch(/^First read the flow's research checklist/)
		expect(check?.actionPrompt).toContain('Competitor research checklist')
		expect(check?.actionPrompt).toContain('at most 3 questions at a time')
		expect(check?.actionPrompt).toContain('only when every child task is done or discarded')
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

	// Scope ruling: this flow covers competitors, personal agents and the category. Customers and
	// prospects belong to another flow, and the weekly deck, its check, the owner heartbeat and
	// the Results tab live only in the source workspace.
	it('covers competitors, personal agents and the category, and not customers or prospects', () => {
		const texts = [
			...MARKET_WATCH_TRIGGER_IDS.map((id) => getTriggerData(id).actionPrompt ?? ''),
			...MARKET_WATCH_SKILL_IDS.map((id) => getSkillData(id).content ?? ''),
		].join('\n')
		expect(texts).toMatch(/personal-agent-intel/)
		expect(texts).not.toMatch(/learn-from/i)
		expect(texts).not.toMatch(/customer-direction/)
		expect(texts).not.toMatch(/Customers and prospects\*\*/)
		expect(texts).not.toMatch(/Market & Competitor Watch/)
	})

	it('ships no deck step, deck check, owner heartbeat, targets or views', () => {
		const names = MARKET_WATCH_TRIGGER_IDS.map((id) => getTriggerData(id).name)
		expect(names).toEqual([
			'Weekly sweep',
			'Monthly revalidation',
			'Monthly outlook and positioning',
			'Weekly briefing check',
		])
		const prompts = MARKET_WATCH_TRIGGER_IDS.map((id) => getTriggerData(id).actionPrompt ?? '')
		for (const prompt of prompts) expect(prompt).not.toMatch(/\bdeck\b|heartbeat/i)
		expect(MARKET_WATCH_LOOP.settings.targets).toBeUndefined()
	})

	it('names the flow Competitor watch in every trigger prompt and skill that names it', () => {
		const trigger = MARKET_WATCH_TRIGGER_IDS.map((id) => getTriggerData(id).actionPrompt ?? '')
		const skills = MARKET_WATCH_SKILL_IDS.map((id) => getSkillData(id).content ?? '')
		expect(trigger.filter((t) => t.includes('Competitor watch')).length).toBe(4)
		expect(skills.join('\n')).toMatch(/name Competitor watch/)
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		const texts = [
			MARKET_WATCH_LOOP.description,
			MARKET_WATCH_LOOP.settings.entryCondition,
			MARKET_WATCH_LOOP.settings.closeCondition,
			MARKET_WATCH_LOOP.settings.checklist?.title,
			MARKET_WATCH_LOOP.settings.checklist?.body,
			...(MARKET_WATCH_LOOP.settings.checklist?.items ?? []).map((i) => `${i.title} ${i.body}`),
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
			...(MARKET_WATCH_LOOP.settings.checklist?.items ?? []).map((i) => `${i.title} ${i.body}`),
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
