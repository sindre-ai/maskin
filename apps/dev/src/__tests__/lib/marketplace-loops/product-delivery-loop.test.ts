import { describe, expect, it } from 'vitest'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import {
	PRODUCT_DELIVERY_ACTOR_IDS,
	PRODUCT_DELIVERY_LOOP,
	PRODUCT_DELIVERY_SKILL_IDS,
	PRODUCT_DELIVERY_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/product-delivery-loop'

function publishedTexts(): string[] {
	return [
		PRODUCT_DELIVERY_LOOP.description,
		PRODUCT_DELIVERY_LOOP.settings.entryCondition,
		PRODUCT_DELIVERY_LOOP.settings.closeCondition,
		...PRODUCT_DELIVERY_ACTOR_IDS.map((id) => {
			const a = getActorData(id)
			return `${a.name} ${a.description} ${a.systemPrompt}`
		}),
		...PRODUCT_DELIVERY_TRIGGER_IDS.map((id) => {
			const t = getTriggerData(id)
			return `${t.name} ${t.actionPrompt ?? ''}`
		}),
		...PRODUCT_DELIVERY_SKILL_IDS.map((id) => {
			const s = getSkillData(id)
			return `${s.name} ${s.description} ${s.content ?? ''}`
		}),
	]
}

describe('Product Delivery flow definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(PRODUCT_DELIVERY_LOOP.slug).toBe('product-delivery-loop')
		expect(PRODUCT_DELIVERY_LOOP.name).toBe('Product Delivery')
		expect(PRODUCT_DELIVERY_LOOP.useCase).toBe('Delivery')
		expect(PRODUCT_DELIVERY_LOOP.version).toBe('1.0.0')
		expect(PRODUCT_DELIVERY_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships entry condition, close condition and tags, with no targets', () => {
		const settings = loopSettingsSchema.parse(PRODUCT_DELIVERY_LOOP.settings)
		expect(settings.entryCondition).toMatch(/define/)
		expect(settings.closeCondition).toMatch(/live/)
		expect(settings.tags).toEqual(['Delivery'])
		expect(settings.targets).toBeUndefined()
	})

	it('ships four actors, ten triggers and two skills, no duplicates', () => {
		expect(PRODUCT_DELIVERY_ACTOR_IDS.length).toBe(4)
		expect(PRODUCT_DELIVERY_TRIGGER_IDS.length).toBe(10)
		expect(PRODUCT_DELIVERY_SKILL_IDS.length).toBe(2)
		expect(new Set(PRODUCT_DELIVERY_TRIGGER_IDS).size).toBe(PRODUCT_DELIVERY_TRIGGER_IDS.length)
	})

	it('names the actors by neutral role', () => {
		expect(PRODUCT_DELIVERY_ACTOR_IDS.map((id) => getActorData(id).name)).toEqual([
			'Delivery Lead',
			'Developer',
			'Reviewer',
			'Coordinator',
		])
	})

	it('wires every trigger to a published actor and every skill to published actors only', () => {
		const actorIds = new Set<string>(PRODUCT_DELIVERY_ACTOR_IDS)
		for (const id of PRODUCT_DELIVERY_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of PRODUCT_DELIVERY_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	it('runs on bet and task status changes plus four timers', () => {
		const triggers = PRODUCT_DELIVERY_TRIGGER_IDS.map(getTriggerData)
		expect(
			triggers
				.filter((t) => t.type === 'event')
				.map((t) => t.config)
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		).toEqual(
			[
				{ action: 'status_changed', filter: { status: 'define' }, entity_type: 'bet' },
				{ action: 'status_changed', filter: { status: 'live' }, entity_type: 'bet' },
				{ action: 'status_changed', filter: { status: 'in_review' }, entity_type: 'task' },
				{ action: 'status_changed', filter: { status: 'todo' }, entity_type: 'task' },
				{ action: 'status_changed', filter: { status: 'validated' }, entity_type: 'task' },
				{ action: 'status_changed', filter: { status: 'validated' }, entity_type: 'task' },
			].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		)
		expect(triggers.filter((t) => t.type === 'cron').length).toBe(4)
	})

	it('names the timer in UTC and ships every trigger enabled', () => {
		for (const id of PRODUCT_DELIVERY_TRIGGER_IDS) {
			const t = getTriggerData(id)
			expect(t.enabled).toBe(true)
			if (t.type === 'cron') expect(t.name).toMatch(/UTC/)
		}
	})

	it('names the flow in every trigger prompt that needs it so agents can find it', () => {
		const needs = PRODUCT_DELIVERY_TRIGGER_IDS.map(getTriggerData).filter(
			(t) => t.type === 'cron' || /in_loop/.test(t.actionPrompt ?? ''),
		)
		expect(needs.length).toBeGreaterThan(0)
		for (const t of needs) {
			expect(t.actionPrompt).toContain(
				`flow named ${PRODUCT_DELIVERY_LOOP.name} (find it with list_loops)`,
			)
		}
	})

	it('ships a generic merge step with the merge rules in a skill', () => {
		const merge = PRODUCT_DELIVERY_TRIGGER_IDS.map(getTriggerData).filter((t) =>
			/merge/i.test(t.name),
		)
		expect(merge.length).toBe(2)
		for (const t of merge) {
			expect(t.actionPrompt).toContain('merge-gate')
			expect(t.actionPrompt).toMatch(/Never update a pull request branch|never update/i)
		}
		const gate = PRODUCT_DELIVERY_SKILL_IDS.map(getSkillData).find((s) => s.name === 'merge-gate')
		expect(gate?.content).toMatch(/default branch/)
		expect(gate?.content).toMatch(/auto-merge/)
	})

	it('has the code host and analytics fallbacks in the prompts', () => {
		const sweep = PRODUCT_DELIVERY_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Daily product sweep'),
		)
		expect(sweep?.actionPrompt).toMatch(/no analytics tool is connected/i)
		expect(sweep?.actionPrompt).toMatch(/disable this trigger/)
		const mergeSweep = PRODUCT_DELIVERY_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Merge sweep'),
		)
		expect(mergeSweep?.actionPrompt).toMatch(/no code host is connected/i)
	})

	it('ships the success-criteria step at define and leaves spec, sizing and go to others', () => {
		const shape = PRODUCT_DELIVERY_TRIGGER_IDS.map(getTriggerData).find(
			(t) => t.name === 'Shape success criteria',
		)
		expect(shape?.config).toEqual({
			action: 'status_changed',
			filter: { status: 'define' },
			entity_type: 'bet',
		})
		expect(shape?.actionPrompt).toMatch(/go decision/)
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		for (const text of publishedTexts()) {
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/—|–|assum/i)
			// People, company, product, repositories, channels and other workflows from the source.
			expect(text).not.toMatch(
				/sebastian|sebk|magnus|\bcto\b|\bcpo\b|\bpmm\b|strategist|code reviewer|workspace driver|product marketing|skjald|sindre|vaerksted|maskin|posthog|slack|#development|fast track|release-gate|bet execution|drive-to-outcome/i,
			)
			expect(text).not.toMatch(/\b20(2\d)\b|https?:\/\/|\bPR \d|\b\d{4}\b/)
			// Never pitch approval as the value of the flow.
			expect(text).not.toMatch(/you approve|nothing happens until|stay in control/i)
		}
	})

	it('says flow, not loop, in the text a person reads', () => {
		// Tool and object type names (list_loops, in_loop) are one word, so they do not match.
		for (const text of publishedTexts()) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of PRODUCT_DELIVERY_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})
})
