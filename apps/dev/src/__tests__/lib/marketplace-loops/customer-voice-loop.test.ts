import { describe, expect, it } from 'vitest'
import {
	CUSTOMER_VOICE_ACTOR_IDS,
	CUSTOMER_VOICE_LOOP,
	CUSTOMER_VOICE_SKILL_IDS,
	CUSTOMER_VOICE_TRIGGER_IDS,
	CUSTOMER_VOICE_VIEW_IDS,
} from '../../../lib/marketplace-loops/customer-voice-loop'
import {
	getActorData,
	getSkillData,
	getTriggerData,
	getViewData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import { LOOP_ID_TOKEN } from '../../../lib/marketplace-loops/view-snapshot'

function publishedTexts() {
	return [
		CUSTOMER_VOICE_LOOP.name,
		CUSTOMER_VOICE_LOOP.description,
		CUSTOMER_VOICE_LOOP.settings.entryCondition,
		CUSTOMER_VOICE_LOOP.settings.closeCondition,
		...(CUSTOMER_VOICE_LOOP.settings.targets ?? []).map((t) => `${t.label} ${t.source}`),
		...CUSTOMER_VOICE_ACTOR_IDS.map((id) => {
			const a = getActorData(id)
			return `${a.name} ${a.description} ${a.systemPrompt}`
		}),
		...CUSTOMER_VOICE_TRIGGER_IDS.map((id) => {
			const t = getTriggerData(id)
			return `${t.name} ${t.actionPrompt}`
		}),
		...CUSTOMER_VOICE_SKILL_IDS.map((id) => {
			const s = getSkillData(id)
			return `${s.name} ${s.description} ${s.content}`
		}),
		// The page's own script ids, query helper and id token carry the product name; the text a person reads does not.
		...CUSTOMER_VOICE_VIEW_IDS.map((id) => {
			const v = getViewData(id)
			return `${v.name} ${v.html.replace(/maskin[-.](sources|query)/g, '').replaceAll(LOOP_ID_TOKEN, '')}`
		}),
	]
}

describe('Customer Voice Flow definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(CUSTOMER_VOICE_LOOP.slug).toBe('customer-voice-loop')
		expect(CUSTOMER_VOICE_LOOP.name).toBe('Customer Voice Flow')
		expect(CUSTOMER_VOICE_LOOP.useCase).toBe('Discovery')
		expect(CUSTOMER_VOICE_LOOP.version).toBe('1.0.0')
		expect(CUSTOMER_VOICE_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships entry condition, close condition, tags and one owner-less target the heartbeat keeps', () => {
		const settings = loopSettingsSchema.parse(CUSTOMER_VOICE_LOOP.settings)
		expect(settings.entryCondition).toMatch(/customer or VIP/)
		expect(settings.closeCondition).toMatch(/filed once as an insight/)
		expect(settings.tags).toEqual(['Context'])
		expect(settings.targets?.map((t) => t.label)).toEqual(['Weekly sweeps'])
		expect(settings.targets?.[0]).not.toHaveProperty('ownerActorId')
		const heartbeat = CUSTOMER_VOICE_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Owner heartbeat'),
		)
		expect(heartbeat?.actionPrompt).toContain('Weekly sweeps')
	})

	it('ships one agent, two triggers, three skills and one view, no duplicates', () => {
		expect(CUSTOMER_VOICE_ACTOR_IDS.length).toBe(1)
		expect(CUSTOMER_VOICE_TRIGGER_IDS.length).toBe(2)
		expect(CUSTOMER_VOICE_SKILL_IDS.length).toBe(3)
		expect(CUSTOMER_VOICE_VIEW_IDS.length).toBe(1)
		expect(new Set(CUSTOMER_VOICE_TRIGGER_IDS).size).toBe(2)
		expect(new Set(CUSTOMER_VOICE_SKILL_IDS).size).toBe(3)
	})

	it('has a weekday sweep and an owner heartbeat, both on cron and enabled', () => {
		const byName = CUSTOMER_VOICE_TRIGGER_IDS.map(getTriggerData)
		expect(byName.map((t) => t.name)).toEqual([
			'Customer voice sweep (weekdays 06:30 UTC)',
			'Owner heartbeat (weekdays 07:56 UTC)',
		])
		expect(byName.map((t) => (t.config as { expression: string }).expression)).toEqual([
			'30 6 * * 1-5',
			'56 7 * * 1-5',
		])
		for (const t of byName) {
			expect(t.type).toBe('cron')
			expect(t.enabled).toBe(true)
		}
	})

	it('wires every trigger to the shipped agent and every skill to it alone', () => {
		const actorIds = new Set<string>(CUSTOMER_VOICE_ACTOR_IDS)
		for (const id of CUSTOMER_VOICE_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of CUSTOMER_VOICE_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	it('has a sweep that finds the flow by name, links each insight into it and reads only what is connected', () => {
		const sweep = getTriggerData(CUSTOMER_VOICE_TRIGGER_IDS[0] as string).actionPrompt ?? ''
		expect(sweep).toContain(`the flow named ${CUSTOMER_VOICE_LOOP.name}`)
		expect(sweep).toContain('list_loops')
		expect(sweep).toMatch(/in_loop relationship/)
		expect(sweep).toMatch(/status new, metadata source customer_feedback/)
		expect(sweep).toMatch(/all optional/)
		expect(sweep).toMatch(/Do not reply to anyone/)
		expect(sweep).toMatch(/untrusted content/)
	})

	it('names the flow the same way in every prompt that looks it up', () => {
		for (const id of CUSTOMER_VOICE_TRIGGER_IDS) {
			expect(getTriggerData(id).actionPrompt).toContain(CUSTOMER_VOICE_LOOP.name)
		}
		for (const id of CUSTOMER_VOICE_ACTOR_IDS) {
			expect(getActorData(id).systemPrompt).toContain(CUSTOMER_VOICE_LOOP.name)
		}
	})

	it('has a Results tab whose page reads this flow through the id token and starts in the quiet state', () => {
		const view = getViewData(CUSTOMER_VOICE_VIEW_IDS[0] as string)
		expect(view.name).toBe('Results')
		expect(view.html).toContain(LOOP_ID_TOKEN)
		const data = /<script id="results-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
			view.html,
		)?.[1]
		expect(data).toBeTruthy()
		const parsed = JSON.parse(data as string)
		expect(parsed.items).toEqual([])
		expect(parsed.monitor).toEqual([])
		expect(parsed.recent).toEqual([])
		expect(parsed.considered).toMatch(/^0 messages weighed/)
	})

	it('keeps the published text free of workspace-specific names, ids, channels, dates and counts', () => {
		for (const text of publishedTexts()) {
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/—|–|assum/i)
			expect(text).not.toMatch(/`/)
			// people and company
			expect(text).not.toMatch(/maskin|vaerksted|sebastian|sebk|magnus|krumhausen/i)
			// the source workspace's customers, channels, tools and sibling flow
			expect(text).not.toMatch(/coach|modl|abtion|telnyx|dinero|customer feedback to resolution/i)
			expect(text).not.toMatch(
				/#[a-z][a-z0-9-]+-(maskin|app|feedback)|\bC0[A-Z0-9]{8,}\b|\bU0[A-Z0-9]{7,}\b/,
			)
			expect(text).not.toMatch(/@[a-z0-9-]+\.(io|com|dk)\b/i)
			// dates, years, months and counts
			expect(text).not.toMatch(/\b20[2-3]\d\b/)
			expect(text).not.toMatch(
				/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i,
			)
			expect(text).not.toMatch(/\b\d+ (new )?(threads|messages|insights) (found|read|filed)\b/i)
		}
	})

	it('says flow, not loop, in the text a person reads', () => {
		// Tool and object type names (list_loops, in_loop) are one word, so they do not match.
		for (const text of publishedTexts()) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of CUSTOMER_VOICE_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})
})
