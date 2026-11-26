import { describe, expect, it } from 'vitest'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import {
	PRODUCT_RELEASE_ACTOR_IDS,
	PRODUCT_RELEASE_LOOP,
	PRODUCT_RELEASE_SKILL_IDS,
	PRODUCT_RELEASE_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/product-release-loop'

function publishedTexts(): string[] {
	return [
		PRODUCT_RELEASE_LOOP.description,
		PRODUCT_RELEASE_LOOP.settings.entryCondition,
		PRODUCT_RELEASE_LOOP.settings.closeCondition,
		...PRODUCT_RELEASE_ACTOR_IDS.map((id) => {
			const a = getActorData(id)
			return `${a.name} ${a.description} ${a.systemPrompt}`
		}),
		...PRODUCT_RELEASE_TRIGGER_IDS.map((id) => {
			const t = getTriggerData(id)
			return `${t.name} ${t.actionPrompt ?? ''}`
		}),
		...PRODUCT_RELEASE_SKILL_IDS.map((id) => getSkillData(id).content ?? ''),
	]
}

describe('Product release loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(PRODUCT_RELEASE_LOOP.slug).toBe('product-release-loop')
		expect(PRODUCT_RELEASE_LOOP.name).toBe('Product release')
		expect(PRODUCT_RELEASE_LOOP.useCase).toBe('Delivery')
		expect(PRODUCT_RELEASE_LOOP.version).toBe('1.0.0')
		expect(PRODUCT_RELEASE_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships entry condition, close condition and tags, with no targets', () => {
		const settings = loopSettingsSchema.parse(PRODUCT_RELEASE_LOOP.settings)
		expect(settings.entryCondition).toMatch(/merged/)
		expect(settings.closeCondition).toMatch(/read back/)
		expect(settings.tags).toEqual(['Delivery'])
		expect(settings.targets).toBeUndefined()
	})

	it('ships two actors, three triggers and one skill, no duplicates', () => {
		expect(PRODUCT_RELEASE_ACTOR_IDS.length).toBe(2)
		expect(PRODUCT_RELEASE_TRIGGER_IDS.length).toBe(3)
		expect(PRODUCT_RELEASE_SKILL_IDS.length).toBe(1)
		expect(new Set(PRODUCT_RELEASE_TRIGGER_IDS).size).toBe(PRODUCT_RELEASE_TRIGGER_IDS.length)
	})

	it('wires every trigger to a published actor and every skill to published actors only', () => {
		const actorIds = new Set<string>(PRODUCT_RELEASE_ACTOR_IDS)
		for (const id of PRODUCT_RELEASE_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of PRODUCT_RELEASE_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	it('fires the confirm step only on release tasks moving to in_review', () => {
		const event = PRODUCT_RELEASE_TRIGGER_IDS.map(getTriggerData).filter((t) => t.type === 'event')
		expect(event.map((t) => t.config)).toEqual([
			{
				action: 'status_changed',
				filter: { status: 'in_review', 'metadata.kind': 'release' },
				entity_type: 'task',
			},
		])
	})

	it('names the flow in every trigger prompt so agents can find it', () => {
		for (const id of PRODUCT_RELEASE_TRIGGER_IDS) {
			expect(getTriggerData(id).actionPrompt).toContain(
				`flow named ${PRODUCT_RELEASE_LOOP.name} (find it with list_loops)`,
			)
		}
	})

	it('has the code-host and store fallbacks in the prompts', () => {
		const bundle = PRODUCT_RELEASE_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Bundle'),
		)
		expect(bundle?.actionPrompt).toMatch(/no code host is connected/)
		expect(bundle?.actionPrompt).toMatch(/never post it twice/)
		const store = PRODUCT_RELEASE_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.includes('store step'),
		)
		expect(store?.actionPrompt).toMatch(/no store is connected/)
		expect(store?.actionPrompt).toMatch(/disable this trigger/)
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		for (const text of publishedTexts()) {
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/—|assum/i)
			// People, company, product, repositories, workflows and version strings from the source.
			expect(text).not.toMatch(
				/sebastian|magnus|\bcto\b|\bcpo\b|\bpmm\b|product marketing|seo builder|skjald|sindre|maskin\.io|apps\/apple|MARKETING_VERSION|ios-testflight|testflight|iphone 1\.|changelog/i,
			)
			expect(text).not.toMatch(/\b20(2\d)\b|https?:\/\//)
		}
	})

	it('says flow, not loop, in the text a person reads', () => {
		// Tool and object type names (list_loops, in_loop) are one word, so they do not match.
		for (const text of publishedTexts()) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of PRODUCT_RELEASE_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})
})
