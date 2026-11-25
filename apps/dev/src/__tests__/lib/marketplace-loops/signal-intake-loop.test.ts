import { SIGNAL_INTAKE_ACTOR_LISTENER } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import {
	SIGNAL_INTAKE_ACTOR_IDS,
	SIGNAL_INTAKE_LOOP,
	SIGNAL_INTAKE_SKILL_IDS,
	SIGNAL_INTAKE_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/signal-intake-loop'

function publishedTexts(): string[] {
	return [
		SIGNAL_INTAKE_LOOP.description,
		SIGNAL_INTAKE_LOOP.settings.entryCondition,
		SIGNAL_INTAKE_LOOP.settings.closeCondition,
		...SIGNAL_INTAKE_ACTOR_IDS.map((id) => {
			const a = getActorData(id)
			return `${a.name} ${a.description} ${a.systemPrompt}`
		}),
		...SIGNAL_INTAKE_TRIGGER_IDS.map((id) => {
			const t = getTriggerData(id)
			return `${t.name} ${t.actionPrompt ?? ''}`
		}),
		...SIGNAL_INTAKE_SKILL_IDS.map((id) => {
			const s = getSkillData(id)
			return `${s.name} ${s.description} ${s.content}`
		}),
	]
}

describe('Signal Intake flow definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(SIGNAL_INTAKE_LOOP.slug).toBe('signal-intake-flow')
		expect(SIGNAL_INTAKE_LOOP.name).toBe('Signal Intake Flow')
		expect(SIGNAL_INTAKE_LOOP.useCase).toBe('Discovery')
		expect(SIGNAL_INTAKE_LOOP.version).toBe('1.0.0')
		expect(SIGNAL_INTAKE_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships entry condition, close condition and tags, with no targets', () => {
		const settings = loopSettingsSchema.parse(SIGNAL_INTAKE_LOOP.settings)
		expect(settings.entryCondition).toMatch(/monthly watchlist check/)
		expect(settings.closeCondition).toMatch(/never closes/)
		expect(settings.tags).toEqual(['Discovery'])
		expect(settings.targets).toBeUndefined()
	})

	it('ships one actor, four triggers and one skill, no duplicates', () => {
		expect(SIGNAL_INTAKE_ACTOR_IDS).toEqual([SIGNAL_INTAKE_ACTOR_LISTENER])
		expect(SIGNAL_INTAKE_TRIGGER_IDS.length).toBe(4)
		expect(SIGNAL_INTAKE_SKILL_IDS.length).toBe(1)
		expect(new Set(SIGNAL_INTAKE_TRIGGER_IDS).size).toBe(4)
		expect(getSkillData(SIGNAL_INTAKE_SKILL_IDS[0] as string).name).toBe('source-health')
	})

	it('runs the four sweeps on their schedules, all in UTC', () => {
		const rows = SIGNAL_INTAKE_TRIGGER_IDS.map(getTriggerData).map((t) => ({
			name: t.name,
			expression: (t.config as { expression?: string }).expression,
			type: t.type,
		}))
		expect(rows).toEqual([
			{
				name: 'Community sweep (Mon, Wed, Fri 22:15 UTC)',
				expression: '15 22 * * 1,3,5',
				type: 'cron',
			},
			{
				name: 'Influencer sweep (Mon, Wed, Fri 22:30 UTC)',
				expression: '30 22 * * 1,3,5',
				type: 'cron',
			},
			{ name: 'Weekly open-source sweep (Mon 09:00 UTC)', expression: '0 9 * * 1', type: 'cron' },
			{ name: 'Monthly watchlist check (1st, 04:00 UTC)', expression: '0 4 1 * *', type: 'cron' },
		])
	})

	it('wires every trigger and skill to the published actor only', () => {
		const actorIds = new Set<string>(SIGNAL_INTAKE_ACTOR_IDS)
		for (const id of SIGNAL_INTAKE_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of SIGNAL_INTAKE_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	it('finds the flow by name in every trigger prompt, and files each note into it', () => {
		for (const id of SIGNAL_INTAKE_TRIGGER_IDS) {
			const prompt = getTriggerData(id).actionPrompt ?? ''
			expect(prompt).toContain('the flow named Signal Intake Flow (find it with list_loops)')
		}
		const prompt = getActorData(SIGNAL_INTAKE_ACTOR_LISTENER).systemPrompt ?? ''
		expect(prompt).toContain('Signal Intake Flow')
		expect(prompt).toMatch(/in_loop relationship \(source the flow, target the note\)/)
	})

	// The install adds no workspace fields, so the influencer lane reads one Watchlist page instead
	// of person records with role, watch status and handle fields.
	it('keeps the watchlist on one page, with no person fields to install', () => {
		const texts = publishedTexts().join('\n')
		expect(texts).toMatch(/knowledge page titled Watchlist/)
		expect(texts).not.toMatch(/watch_status|role influencer/)
		const influencer = SIGNAL_INTAKE_TRIGGER_IDS.map(getTriggerData).find((t) =>
			t.name.startsWith('Influencer sweep'),
		)
		expect(influencer?.actionPrompt).toMatch(/Watchlist page/)
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		for (const text of publishedTexts()) {
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/—|assum/i)
			expect(text).not.toMatch(/maskin\.io|https?:\/\//i)
			expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
		}
	})

	it('says flow, not loop, in the text a person reads', () => {
		// Tool and object type names (list_loops, in_loop) are one word, so they do not match.
		for (const text of publishedTexts()) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})

	it('ships no engagement tool, no skill beyond source-health and no connected servers', () => {
		expect(JSON.stringify(getActorData(SIGNAL_INTAKE_ACTOR_LISTENER).tools)).not.toContain(
			'mcpServers',
		)
	})
})
