import { describe, expect, it } from 'vitest'
import {
	getActorData,
	getSkillData,
	getTriggerData,
	getViewData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import {
	PRODUCT_USAGE_ACTOR_IDS,
	PRODUCT_USAGE_LOOP,
	PRODUCT_USAGE_SKILL_IDS,
	PRODUCT_USAGE_TRIGGER_IDS,
	PRODUCT_USAGE_VIEW_IDS,
} from '../../../lib/marketplace-loops/product-usage-loop'
import { LOOP_ID_TOKEN } from '../../../lib/marketplace-loops/view-snapshot'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function shippedText() {
	return [
		PRODUCT_USAGE_LOOP,
		...PRODUCT_USAGE_ACTOR_IDS.map(getActorData),
		...PRODUCT_USAGE_TRIGGER_IDS.map(getTriggerData),
		...PRODUCT_USAGE_SKILL_IDS.map(getSkillData),
	]
}

describe('Product Usage flow definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(PRODUCT_USAGE_LOOP.slug).toBe('product-usage-loop')
		expect(PRODUCT_USAGE_LOOP.name).toBe('Product Usage')
		expect(PRODUCT_USAGE_LOOP.useCase).toBe('Discovery')
		expect(PRODUCT_USAGE_LOOP.version).toBe('1.0.0')
		expect(PRODUCT_USAGE_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships one actor, two triggers and two skills, no duplicates', () => {
		expect(PRODUCT_USAGE_ACTOR_IDS.length).toBe(1)
		expect(getActorData(PRODUCT_USAGE_ACTOR_IDS[0] as string).name).toBe('Product Analyst')
		expect(PRODUCT_USAGE_TRIGGER_IDS.map((id) => getTriggerData(id).name).sort()).toEqual([
			'Owner heartbeat (Tue to Fri 07:56 UTC)',
			'Weekly usage read (Mon 07:00 UTC)',
		])
		expect(PRODUCT_USAGE_SKILL_IDS.map((id) => getSkillData(id).name).sort()).toEqual([
			'drive-to-outcome',
			'results-view-refresh',
		])
		expect(new Set(PRODUCT_USAGE_TRIGGER_IDS).size).toBe(PRODUCT_USAGE_TRIGGER_IDS.length)
		expect(new Set(PRODUCT_USAGE_SKILL_IDS).size).toBe(PRODUCT_USAGE_SKILL_IDS.length)
	})

	it('wires every trigger to the published actor and every skill to published actors only', () => {
		const actorIds = new Set<string>(PRODUCT_USAGE_ACTOR_IDS)
		for (const id of PRODUCT_USAGE_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of PRODUCT_USAGE_SKILL_IDS) {
			const { attachedActorIds } = getSkillData(id)
			expect(attachedActorIds.length).toBeGreaterThan(0)
			for (const actorId of attachedActorIds) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	it('ships entry condition, close condition, a tag and the one target the heartbeat keeps current', () => {
		const settings = loopSettingsSchema.parse(PRODUCT_USAGE_LOOP.settings)
		expect(settings.entryCondition).toBeTruthy()
		expect(settings.closeCondition).toMatch(/no product analytics tool connected/)
		expect(settings.tags).toEqual(['Product'])
		expect(settings.targets?.map((t) => t.label)).toEqual(['Usage reads'])
		expect(settings.targets?.[0]).not.toHaveProperty('ownerActorId')
		const heartbeat = PRODUCT_USAGE_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Owner heartbeat'),
		)
		expect(heartbeat?.actionPrompt).toContain('target Usage reads')
	})

	// With no analytics tool connected the Monday read must say so once and stop, and the
	// heartbeat must not start a read of its own in that case.
	it('says so once and stops when no product analytics tool is connected', () => {
		const monday = PRODUCT_USAGE_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Weekly usage read'),
		)
		const prompt = monday?.actionPrompt ?? ''
		expect(prompt).toMatch(/If none is connected/)
		expect(prompt).toMatch(/does not already say so, post one line/)
		expect(prompt).toMatch(/Then stop\. File nothing and read no other source/)
		const heartbeat = PRODUCT_USAGE_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Owner heartbeat'),
		)
		expect(heartbeat?.actionPrompt).toMatch(/no product analytics tool is connected, say so once/)
		expect(getActorData(PRODUCT_USAGE_ACTOR_IDS[0] as string).systemPrompt).toMatch(
			/If no product analytics tool is connected/,
		)
	})

	it('does not name a tool, a volume band or a platform of the source workspace', () => {
		const text = JSON.stringify(shippedText())
		expect(text).not.toMatch(/5k|20k|iphone|\bios\b|tracking plan bet/i)
		// PostHog appears only as one example in a list of tools the installer may connect.
		expect(text.match(/posthog/gi)?.length ?? 0).toBeLessThanOrEqual(2)
	})

	// This bundle is a template for any workspace: nothing in it may name the company,
	// people or agents it was derived from, carry a date or count, or carry a source id.
	it('carries no workspace-specific text', () => {
		const text = JSON.stringify(shippedText())
		const forbidden = [
			/sebastian|sebk|magnus/i,
			/vaerksted|skjald|meshfirm/i,
			/maskin/i,
			/\bCTO\b|\bCCO\b|\bCPO\b|chief of staff/i,
			/assum/i,
			/—/,
			/\b(Customer Success|Content Lead|Product Marketing|Head of Growth|Prospector|Events Lead|Fundraiser|Skjald PM|Product Designer|Workspace Coach|Design Studio|Product Validator|Code Reviewer|Developer|Planner|Architect|Product Insights Analyst|Signal Analyst|Bet Revalidator|Product Lead|Bet Shaper|Workspace Driver|Researcher|Product Manager|Linker)\b/,
			/\b20\d\d\b/,
			/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/,
			/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/,
		]
		for (const pattern of forbidden) expect(text).not.toMatch(pattern)

		const ownIds = new Set<string>([
			...PRODUCT_USAGE_ACTOR_IDS,
			...PRODUCT_USAGE_TRIGGER_IDS,
			...PRODUCT_USAGE_SKILL_IDS,
			'00000000-0000-0000-0000-000000000000',
		])
		for (const id of text.match(UUID) ?? []) expect(ownIds.has(id)).toBe(true)
	})

	it('says flow, not loop, in the text a person reads', () => {
		for (const part of shippedText()) {
			// Tool and object type names (list_loops, in_loop) are one word, so they do not match.
			expect(JSON.stringify(part)).not.toMatch(/\b[Ll]oops?\b/)
		}
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of PRODUCT_USAGE_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})

	it('ships the Results tab as a neutral starter page scoped to the installed flow', () => {
		expect(PRODUCT_USAGE_VIEW_IDS.map((id) => getViewData(id).name)).toEqual(['Results'])
		const view = getViewData(PRODUCT_USAGE_VIEW_IDS[0] as string)
		expect(view.html).toContain(`"scope":"${LOOP_ID_TOKEN}"`)

		const data = view.html.match(
			/<script id="results-data" type="application\/json">(.*?)<\/script>/s,
		)
		expect(data).not.toBeNull()
		const parsed = JSON.parse(data?.[1] ?? '{}') as { items: unknown[]; considered: string }
		expect(parsed.items).toEqual([])
		expect(parsed.considered).toBe('No read has run yet.')

		const text = view.html
		const forbidden = [
			/sebastian|sebk|magnus/i,
			/vaerksted|skjald|meshfirm/i,
			/maskin\.io/i,
			/\bCTO\b|\bCCO\b|chief of staff/i,
			/\b20\d\d\b/,
			/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/,
			/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/,
		]
		for (const pattern of forbidden) expect(text).not.toMatch(pattern)
		expect(text.match(UUID) ?? []).toEqual([])
	})
})
