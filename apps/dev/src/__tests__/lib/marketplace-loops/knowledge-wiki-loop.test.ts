import { describe, expect, it } from 'vitest'
import {
	KNOWLEDGE_WIKI_ACTOR_IDS,
	KNOWLEDGE_WIKI_LOOP,
	KNOWLEDGE_WIKI_SKILL_IDS,
	KNOWLEDGE_WIKI_TRIGGER_IDS,
	KNOWLEDGE_WIKI_VIEW_IDS,
} from '../../../lib/marketplace-loops/knowledge-wiki-loop'
import {
	getActorData,
	getSkillData,
	getTriggerData,
	getViewData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'

const ACTOR_TEXTS = KNOWLEDGE_WIKI_ACTOR_IDS.map((id) => {
	const a = getActorData(id)
	return `${a.name} ${a.description} ${a.systemPrompt}`
})
const TRIGGER_TEXTS = KNOWLEDGE_WIKI_TRIGGER_IDS.map((id) => {
	const t = getTriggerData(id)
	return `${t.name} ${t.actionPrompt ?? ''}`
})
const SKILL_TEXTS = KNOWLEDGE_WIKI_SKILL_IDS.map((id) => {
	const s = getSkillData(id)
	return `${s.name} ${s.description ?? ''} ${s.content ?? ''}`
})
const VIEW_TEXTS = KNOWLEDGE_WIKI_VIEW_IDS.map((id) => getViewData(id).html)
const READABLE_TEXTS = [
	KNOWLEDGE_WIKI_LOOP.description,
	KNOWLEDGE_WIKI_LOOP.settings.entryCondition,
	KNOWLEDGE_WIKI_LOOP.settings.closeCondition,
	...ACTOR_TEXTS,
	...TRIGGER_TEXTS,
	...SKILL_TEXTS,
]

describe('Knowledge Wiki flow definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(KNOWLEDGE_WIKI_LOOP.slug).toBe('knowledge-wiki-loop')
		expect(KNOWLEDGE_WIKI_LOOP.name).toBe('Knowledge Wiki')
		expect(KNOWLEDGE_WIKI_LOOP.useCase).toBe('Context')
		expect(KNOWLEDGE_WIKI_LOOP.version).toBe('1.0.0')
		expect(KNOWLEDGE_WIKI_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships the conditions, a tag and the two targets its weekly prune recounts', () => {
		const settings = loopSettingsSchema.parse(KNOWLEDGE_WIKI_LOOP.settings)
		expect(settings.entryCondition).toMatch(/knowledge page is created/)
		expect(settings.closeCondition).toMatch(/does not close/)
		expect(settings.tags).toEqual(['Context'])
		expect(settings.targets?.map((t) => t.label)).toEqual(['Idle drafts', 'Stale pages'])
		const prune = KNOWLEDGE_WIKI_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Weekly prune'),
		)
		for (const target of settings.targets ?? []) {
			expect(prune?.actionPrompt).toContain(target.label)
			expect(target).not.toHaveProperty('ownerActorId')
		}
	})

	it('ships one agent, four triggers, three skills and two tabs, no duplicates', () => {
		expect(KNOWLEDGE_WIKI_ACTOR_IDS.map((id) => getActorData(id).name)).toEqual([
			'Knowledge Curator',
		])
		expect(KNOWLEDGE_WIKI_TRIGGER_IDS.length).toBe(4)
		expect(KNOWLEDGE_WIKI_SKILL_IDS.length).toBe(3)
		expect(KNOWLEDGE_WIKI_VIEW_IDS.length).toBe(2)
		expect(new Set(KNOWLEDGE_WIKI_TRIGGER_IDS).size).toBe(KNOWLEDGE_WIKI_TRIGGER_IDS.length)
		expect(new Set(KNOWLEDGE_WIKI_SKILL_IDS).size).toBe(KNOWLEDGE_WIKI_SKILL_IDS.length)
	})

	it('carries the four triggers: fold-in on new knowledge, digest, heartbeat and prune', () => {
		const byName = Object.fromEntries(
			KNOWLEDGE_WIKI_TRIGGER_IDS.map((id) => {
				const t = getTriggerData(id)
				return [t.name, { type: t.type, config: t.config }]
			}),
		)
		expect(byName).toEqual({
			'Fold new knowledge into the wiki': {
				type: 'event',
				config: { action: 'created', entity_type: 'knowledge' },
			},
			'Twice-weekly digest (Mon, Thu 05:45 UTC)': {
				type: 'cron',
				config: { expression: '45 5 * * 1,4' },
			},
			'Owner heartbeat (daily 08:03 UTC)': { type: 'cron', config: { expression: '3 8 * * *' } },
			'Weekly prune and improve sweep (Tue 06:00 UTC)': {
				type: 'cron',
				config: { expression: '0 6 * * 2' },
			},
		})
	})

	it('wires every trigger to the published agent and every skill to published agents only', () => {
		const actorIds = new Set<string>(KNOWLEDGE_WIKI_ACTOR_IDS)
		for (const id of KNOWLEDGE_WIKI_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of KNOWLEDGE_WIKI_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	it('looks the flow up by name and never by id', () => {
		for (const text of TRIGGER_TEXTS) {
			expect(text).toContain('Knowledge Wiki')
			expect(text).toContain('list_loops')
		}
	})

	it('finds Wiki Home, Wiki Status and the coverage bar by title and creates them when missing', () => {
		const digest = KNOWLEDGE_WIKI_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Twice-weekly digest'),
		)
		expect(digest?.actionPrompt).toMatch(/Find each by title with search_objects/)
		expect(digest?.actionPrompt).toMatch(/does not exist yet, create it now/)
		expect(digest?.actionPrompt).toMatch(/Wiki Coverage Bar/)
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		for (const text of [...READABLE_TEXTS, ...VIEW_TEXTS]) {
			// ids, links, dates and years
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/https?:\/\/[^"\s]*maskin\.io|maskin\.io/i)
			expect(text).not.toMatch(
				/\b20\d\d\b|\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/,
			)
			expect(text).not.toMatch(/—|assum/i)
			// people, company, product and role titles from the source workspace
			expect(text).not.toMatch(
				/Sebastian|Sebk|Magnus|Netwerk|Maskin\b|Værksted|Krumhausen|Nøddegaard|Slack|Chief of Staff|\bCPO\b|\bCCO\b|\bCTO\b|Content Lead|Customer Success|Product Validator|Product Insights Analyst|Workspace Coach/,
			)
			// the live flow's page names that carried ids
			expect(text).not.toMatch(/Wiki —|Wiki - (Home|Status)/)
		}
	})

	it('says flow, not loop, in the text a person reads', () => {
		// Tool and object type names (list_loops, in_loop) are one word, so they do not match.
		for (const text of READABLE_TEXTS) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of KNOWLEDGE_WIKI_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})

	it('ships the Results and Strategic context tabs as empty starter pages with live counters', () => {
		const views = KNOWLEDGE_WIKI_VIEW_IDS.map(getViewData)
		expect(views.map((v) => [v.name, v.position])).toEqual([
			['Results', 0],
			['Strategic context', 1],
		])
		for (const view of views) {
			const data = /<script id="results-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
				view.html,
			)?.[1]
			const parsed = JSON.parse(data ?? 'null') as { cards: unknown[]; unknowns: unknown[] }
			expect(parsed.cards).toEqual([])
			expect(parsed.unknowns).toEqual([])
			expect(view.html).toContain('maskin.query')
			expect(view.html).toContain('maskin-sources')
		}
	})
})
