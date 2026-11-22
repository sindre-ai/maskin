import { ACCOUNTING_LOOP_ACTOR_BOOKKEEPER } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import {
	ACCOUNTING_LOOP,
	ACCOUNTING_LOOP_ACTOR_IDS,
	ACCOUNTING_LOOP_SKILL_IDS,
	ACCOUNTING_LOOP_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/accounting-loop'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'

const actorTexts = () =>
	ACCOUNTING_LOOP_ACTOR_IDS.map((id) => {
		const a = getActorData(id)
		return `${a.name} ${a.description} ${a.systemPrompt}`
	})
const triggerTexts = () =>
	ACCOUNTING_LOOP_TRIGGER_IDS.map((id) => getTriggerData(id).actionPrompt ?? '')
const skillTexts = () => ACCOUNTING_LOOP_SKILL_IDS.map((id) => getSkillData(id).content ?? '')

describe('Accounting loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(ACCOUNTING_LOOP.slug).toBe('accounting-loop')
		expect(ACCOUNTING_LOOP.name).toBe('Accounting')
		expect(ACCOUNTING_LOOP.useCase).toBe('Finance')
		expect(ACCOUNTING_LOOP.version).toBe('1.0.0')
		expect(ACCOUNTING_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships entry condition, close condition and tags, with no targets', () => {
		const settings = loopSettingsSchema.parse(ACCOUNTING_LOOP.settings)
		expect(settings.entryCondition).toMatch(/uploads a receipt/)
		expect(settings.closeCondition).toMatch(/draft voucher/)
		expect(settings.tags).toEqual(['Finance'])
		expect(settings.targets).toBeUndefined()
	})

	it('ships one actor, one trigger and two skills, no duplicates', () => {
		expect(ACCOUNTING_LOOP_ACTOR_IDS).toEqual([ACCOUNTING_LOOP_ACTOR_BOOKKEEPER])
		expect(ACCOUNTING_LOOP_TRIGGER_IDS.length).toBe(1)
		expect(ACCOUNTING_LOOP_SKILL_IDS.length).toBe(2)
		expect(new Set(ACCOUNTING_LOOP_SKILL_IDS).size).toBe(ACCOUNTING_LOOP_SKILL_IDS.length)
		expect(ACCOUNTING_LOOP_SKILL_IDS.map((id) => getSkillData(id).name).sort()).toEqual([
			'accounting-connection-check',
			'bookkeeping-draft-method',
		])
	})

	it('wires the trigger and every skill to the bundled Bookkeeper only', () => {
		const actorIds = new Set<string>(ACCOUNTING_LOOP_ACTOR_IDS)
		for (const id of ACCOUNTING_LOOP_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of ACCOUNTING_LOOP_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	it('names the flow Accounting in the trigger prompt', () => {
		for (const prompt of triggerTexts()) expect(prompt).toContain('flow named Accounting')
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of ACCOUNTING_LOOP_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})

	// Install step for Dinero's own server: added as a custom tool, limited to drafts, and a plain
	// warning that its sign-in runs out because the flow cannot renew it. A check on every first run.
	it('tells the owner how to connect Dinero and what the first run checks', () => {
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		expect(check).toMatch(/add Dinero's own server as a custom tool/)
		expect(check).toMatch(/only the one company/)
		expect(check).toMatch(/needs someone technical/)
		expect(check).toMatch(/Limit the tool to reading and saving drafts/)
		expect(check).toMatch(/read and write access/)
		expect(check).toMatch(/at the start of every job/i)
		expect(check).toMatch(/no tool that books, posts, changes, deletes, pays or sends/)
		expect(actorTexts().join('\n')).toMatch(/connection check first/)
	})

	it('says the Dinero sign-in runs out and the flow cannot renew it', () => {
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		expect(check).toMatch(/early version/)
		expect(check).toMatch(/runs out after about an hour/)
		expect(check).toMatch(/cannot renew it/)
		expect(ACCOUNTING_LOOP.description).toMatch(/runs out after about an hour/)
		expect(actorTexts().join('\n')).toMatch(/do not try to sign in yourself/i)
	})

	it('has no key-based install step left', () => {
		const all = [ACCOUNTING_LOOP.description, ...actorTexts(), ...skillTexts()].join('\n')
		expect(all).not.toMatch(/client ID|client secret|Connect Dinero form|no browser sign-in/i)
	})

	it('never sees or asks for the sign-in token', () => {
		const prompt = actorTexts().join('\n')
		expect(prompt).toMatch(
			/never see the owner's Dinero sign-in token and never ask for it in chat/,
		)
		expect(skillTexts().join('\n')).toMatch(/Never paste the token in the chat/)
	})

	it('is draft only and takes receipts from uploaded files only', () => {
		const prompt = actorTexts().join('\n')
		expect(prompt).toMatch(/Draft only/)
		expect(prompt).toMatch(/never book, finalise, change, approve, pay, send or delete/i)
		expect(prompt).toMatch(/uploads in the chat/)
		expect(prompt).toMatch(/do not promise that a photo or an email will arrive on its own/i)
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		const texts = [
			ACCOUNTING_LOOP.description,
			ACCOUNTING_LOOP.settings.entryCondition,
			ACCOUNTING_LOOP.settings.closeCondition,
			...actorTexts(),
			...triggerTexts(),
			...skillTexts(),
		]
		for (const text of texts) {
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/—|assum|Lane \d|Sebastian|Magnus|Maskin|bet\b/i)
			expect(text).not.toMatch(/https?:\/\//)
			expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
		}
	})

	it('says flow, not loop, in the text a person reads', () => {
		const texts = [ACCOUNTING_LOOP.description, ...actorTexts(), ...triggerTexts(), ...skillTexts()]
		for (const text of texts) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})
})
